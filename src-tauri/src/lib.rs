use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager};

/// One scratch note in the app-managed store.
#[derive(Serialize, Deserialize, Clone, Default)]
struct Draft {
    id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    content: String,
    #[serde(default)]
    file_path: Option<String>,
    #[serde(default)]
    created_at: i64,
    #[serde(default)]
    updated_at: i64,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// An "orphan" draft has no text and no on-disk file — safe to prune on load.
fn is_orphan(d: &Draft) -> bool {
    d.content.trim().is_empty() && d.file_path.is_none()
}

/// A draft backed by a file whose file has since disappeared (deleted or moved).
/// Such drafts are hidden from the sidebar but their store entry is kept, so a
/// remounted drive or a restored file brings them back on the next launch.
fn file_gone(d: &Draft) -> bool {
    d.file_path
        .as_deref()
        .is_some_and(|p| !std::path::Path::new(p).exists())
}

fn app_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn drafts_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app_dir(app)?.join("drafts");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn draft_file(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    Ok(drafts_dir(app)?.join(format!("{id}.json")))
}

fn read_all_drafts(app: &AppHandle) -> Result<Vec<Draft>, String> {
    let dir = drafts_dir(app)?;
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if let Ok(text) = fs::read_to_string(&path) {
            if let Ok(draft) = serde_json::from_str::<Draft>(&text) {
                out.push(draft);
            }
        }
    }
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(out)
}

fn write_draft(app: &AppHandle, draft: &Draft) -> Result<(), String> {
    let path = draft_file(app, &draft.id)?;
    let json = serde_json::to_string_pretty(draft).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())?;
    if let Some(fp) = &draft.file_path {
        fs::write(fp, &draft.content).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// All saved drafts, newest first. Migrates the legacy single-session file once.
#[tauri::command]
fn init_store(app: AppHandle) -> Result<Vec<Draft>, String> {
    let mut drafts = read_all_drafts(&app)?;

    // Prune empty, unnamed orphans (delete them), and hide drafts whose backing
    // file is gone (keep the store entry so they can come back).
    drafts.retain(|d| {
        if is_orphan(d) {
            if let Ok(p) = draft_file(&app, &d.id) {
                let _ = fs::remove_file(p);
            }
            return false;
        }
        !file_gone(d)
    });

    if drafts.is_empty() {
        let legacy = app_dir(&app)?.join("session.json");
        if let Some(v) = fs::read_to_string(&legacy)
            .ok()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        {
            let content = v.get("content").and_then(|c| c.as_str()).unwrap_or("");
            let file_path = v
                .get("file_path")
                .and_then(|p| p.as_str())
                .map(String::from);
            // Only migrate if there's something worth keeping.
            if !content.trim().is_empty() || file_path.is_some() {
                let now = now_ms();
                let draft = Draft {
                    id: format!("draft-{now}"),
                    title: String::new(),
                    content: content.to_string(),
                    file_path,
                    created_at: now,
                    updated_at: now,
                };
                write_draft(&app, &draft)?;
                drafts.push(draft);
            }
            let _ = fs::remove_file(&legacy);
        }
    }

    Ok(drafts)
}

/// Upsert a draft: write its store file and (if named) the on-disk text file.
#[tauri::command]
fn save_draft(app: AppHandle, draft: Draft) -> Result<(), String> {
    write_draft(&app, &draft)?;
    clear_tombstone(&app, &draft.id); // a re-saved draft is no longer deleted
    Ok(())
}

#[tauri::command]
fn delete_draft(app: AppHandle, id: String) -> Result<(), String> {
    let path = draft_file(&app, &id)?;
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    record_tombstone(&app, &id); // so the deletion propagates on the next sync
    Ok(())
}

/// Record a local deletion so the next sync pushes a DELETE. No-op unless sync is
/// configured (a worker URL is set) — nothing to propagate otherwise.
fn record_tombstone(app: &AppHandle, id: &str) {
    let mut cfg = read_sync_config(app);
    if cfg.url.is_empty() {
        return;
    }
    cfg.tombstones.insert(id.to_string(), now_ms());
    cfg.synced.remove(id);
    let _ = write_sync_config(app, &cfg);
}

/// Drop a pending tombstone for a draft that came back (undo / re-save).
fn clear_tombstone(app: &AppHandle, id: &str) {
    let mut cfg = read_sync_config(app);
    if cfg.url.is_empty() || !cfg.tombstones.contains_key(id) {
        return;
    }
    cfg.tombstones.remove(id);
    let _ = write_sync_config(app, &cfg);
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(path).map_err(|e| e.to_string())
}

/// Write text to an arbitrary path the user picked (used by Export). Unlike
/// `save_draft`, this doesn't touch the draft's own file_path.
#[tauri::command]
fn write_text_file(path: String, contents: String) -> Result<(), String> {
    fs::write(path, contents).map_err(|e| e.to_string())
}

// --- Cloud sync config (opt-in, self-hosted) --------------------------------
//
// The token lives here in Rust — never the webview — so it can't leak through the
// DOM. `synced`/`tombstones` are the C2 sync ledger; defined now so enabling the
// engine later doesn't reshape the on-disk file. Everything is `#[serde(default)]`
// so a partial or older `sync.json` still deserializes.

#[derive(Serialize, Deserialize, Clone, Default)]
struct SyncConfig {
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    url: String,
    #[serde(default)]
    token: String,
    #[serde(default)]
    synced: HashMap<String, i64>,
    #[serde(default)]
    tombstones: HashMap<String, i64>,
}

/// What the settings UI is allowed to see — the token is deliberately omitted.
#[derive(Serialize)]
struct SyncConfigView {
    enabled: bool,
    url: String,
    has_token: bool,
}

/// Result of a `/health` probe. `ok` is true only on HTTP 200; `status` lets the
/// UI distinguish 401 (bad token) from other failures.
#[derive(Serialize)]
struct TestResult {
    ok: bool,
    status: u16,
    version: Option<String>,
}

fn sync_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_dir(app)?.join("sync.json"))
}

fn read_sync_config(app: &AppHandle) -> SyncConfig {
    sync_file(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<SyncConfig>(&s).ok())
        .unwrap_or_default()
}

fn write_sync_config(app: &AppHandle, cfg: &SyncConfig) -> Result<(), String> {
    let path = sync_file(app)?;
    let json = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())?;
    // Restrict to owner-only (0600) on unix — the file holds the auth token. No-op
    // on Windows, which relies on the per-user app_data_dir. Best-effort.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// Normalize a worker URL: trim whitespace and any trailing slashes so request
/// paths (`{url}/health`) compose cleanly and match between save and test.
fn normalize_url(url: &str) -> String {
    url.trim().trim_end_matches('/').to_string()
}

/// Merge a config update onto an existing config, preserving the sync ledger and
/// the stored token when no new token is supplied. Pure, so it's unit-tested.
fn apply_config_update(
    mut cfg: SyncConfig,
    enabled: bool,
    url: String,
    token: Option<String>,
) -> SyncConfig {
    cfg.enabled = enabled;
    cfg.url = normalize_url(&url);
    if let Some(t) = token {
        if !t.is_empty() {
            cfg.token = t;
        }
    }
    cfg
}

/// Save the sync settings. A `None`/empty `token` keeps the stored one, so saving
/// URL/enable alone never wipes the token. `synced`/`tombstones` are preserved.
#[tauri::command]
fn set_sync_config(
    app: AppHandle,
    enabled: bool,
    url: String,
    token: Option<String>,
) -> Result<(), String> {
    let cfg = apply_config_update(read_sync_config(&app), enabled, url, token);
    write_sync_config(&app, &cfg)
}

/// Read the sync settings for the UI — never returns the token.
#[tauri::command]
fn get_sync_config(app: AppHandle) -> SyncConfigView {
    let cfg = read_sync_config(&app);
    SyncConfigView {
        enabled: cfg.enabled,
        url: cfg.url,
        has_token: !cfg.token.is_empty(),
    }
}

/// Return the stored token — only for the settings UI's reveal-eye and "Copy
/// token" actions (the user needs to see/copy it to paste into the worker's
/// SYNC_TOKEN secret). Kept out of `get_sync_config` so the token is fetched only
/// on explicit user intent, never on every settings render.
#[tauri::command]
fn get_sync_token(app: AppHandle) -> String {
    read_sync_config(&app).token
}

/// Probe `{url}/health` using the **stored** URL + token (read from sync.json), so
/// the token never has to enter the webview even to test. The settings UI saves
/// first (`set_sync_config`), then calls this. Transport failures (DNS, timeout,
/// TLS) return `Err` so the UI can show "Unreachable"; a reachable-but-rejecting
/// worker returns `Ok` with the status so the UI can say "Invalid token" on 401.
#[tauri::command]
async fn sync_test_connection(app: AppHandle) -> Result<TestResult, String> {
    let cfg = read_sync_config(&app);
    if cfg.url.is_empty() {
        return Err("no worker url configured".into());
    }
    let base = normalize_url(&cfg.url);
    let token = cfg.token;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(format!("{base}/health"))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    let version = if status == 200 {
        resp.json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|v| {
                v.get("version")
                    .and_then(|x| x.as_str())
                    .map(String::from)
            })
    } else {
        None
    };
    Ok(TestResult {
        ok: status == 200,
        status,
        version,
    })
}

// --- Cloud sync engine (C2) -------------------------------------------------
//
// One `sync_once` pass = pull (remote -> local) then push (local -> remote).
// The Worker is a dumb store; conflict resolution is last-write-wins on
// `updated_at`. `synced[id]` records the value at the last successful sync of a
// draft, so a local draft needs pushing when `updated_at > synced[id]`.
// `tombstones[id]` are local deletions not yet pushed. `file_path` is device-local
// and never synced (stripped on push, preserved on pull).

use std::sync::atomic::{AtomicBool, Ordering};

/// Serialized guard so two syncs never overlap (skip if one is running).
struct SyncState {
    running: AtomicBool,
}

/// One entry from `GET /drafts` (delta listing).
#[derive(Deserialize)]
struct RemoteEntry {
    id: String,
    #[serde(rename = "updatedAt", default)]
    updated_at: i64,
    #[serde(default)]
    deleted: bool,
}

#[derive(Deserialize)]
struct DraftsList {
    #[serde(default)]
    drafts: Vec<RemoteEntry>,
}

/// A local draft needs pushing when its edit is newer than the last synced value
/// (or it was never synced). Pure, so it's unit-tested.
fn needs_push(updated_at: i64, synced: Option<i64>) -> bool {
    updated_at > synced.unwrap_or(i64::MIN)
}

/// Run a full sync pass. Returns whether anything changed on disk locally (so the
/// UI can refresh). No-op (Ok(false)) when sync is disabled or unconfigured.
async fn sync_once(app: &AppHandle) -> Result<bool, String> {
    let cfg = read_sync_config(app);
    // Configured (URL + token) == syncing. No separate enable flag.
    if cfg.url.is_empty() || cfg.token.is_empty() {
        return Ok(false);
    }
    let base = normalize_url(&cfg.url);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;

    let mut synced = cfg.synced.clone();
    let mut tombstones = cfg.tombstones.clone();
    let mut changed = false;

    let mut local: HashMap<String, Draft> = read_all_drafts(app)?
        .into_iter()
        .map(|d| (d.id.clone(), d))
        .collect();

    // --- Pull: remote -> local ---
    let list: DraftsList = client
        .get(format!("{base}/drafts"))
        .bearer_auth(&cfg.token)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    for entry in list.drafts {
        if entry.deleted {
            // Remote deletion wins unless the local copy is strictly newer (edited
            // after the delete -> it will be re-pushed / resurrected below).
            if let Some(l) = local.get(&entry.id) {
                if l.updated_at <= entry.updated_at {
                    if let Ok(p) = draft_file(app, &entry.id) {
                        let _ = fs::remove_file(p);
                    }
                    local.remove(&entry.id);
                    changed = true;
                }
            }
            synced.insert(entry.id.clone(), entry.updated_at);
            tombstones.remove(&entry.id);
            continue;
        }
        let need = match local.get(&entry.id) {
            None => true,
            Some(l) => entry.updated_at > l.updated_at,
        };
        if need {
            let resp = client
                .get(format!("{base}/drafts/{}", entry.id))
                .bearer_auth(&cfg.token)
                .send()
                .await
                .map_err(|e| e.to_string())?;
            if resp.status().is_success() {
                let mut remote: Draft = resp.json().await.map_err(|e| e.to_string())?;
                // Never overwrite the device-local file path; keep the local one.
                remote.file_path = local.get(&entry.id).and_then(|l| l.file_path.clone());
                write_draft(app, &remote)?;
                synced.insert(entry.id.clone(), remote.updated_at);
                local.insert(entry.id.clone(), remote);
                changed = true;
            }
        }
    }

    // --- Push: local -> remote ---
    for (id, d) in local.iter() {
        if is_orphan(d) {
            continue; // empty, unnamed scratch — nothing worth syncing
        }
        if needs_push(d.updated_at, synced.get(id).copied()) {
            let mut up = d.clone();
            up.file_path = None; // device-local; never leaves the machine
            let body = serde_json::to_string(&up).map_err(|e| e.to_string())?;
            let resp = client
                .put(format!("{base}/drafts/{id}"))
                .bearer_auth(&cfg.token)
                .header("content-type", "application/json")
                .body(body)
                .send()
                .await
                .map_err(|e| e.to_string())?;
            if resp.status().is_success() {
                synced.insert(id.clone(), d.updated_at);
            }
        }
    }

    // Push deletions; keep the tombstone for a later retry if the request fails.
    let mut pushed_deletes: Vec<String> = Vec::new();
    for (id, at) in tombstones.iter() {
        let ok = client
            .delete(format!("{base}/drafts/{id}"))
            .bearer_auth(&cfg.token)
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false);
        if ok {
            synced.insert(id.clone(), *at);
            pushed_deletes.push(id.clone());
        }
    }

    // Persist only the ledger; re-read so we don't clobber url/token/enabled — or a
    // deletion recorded mid-sync — that the user may have changed meanwhile. Only
    // the tombstones we actually pushed are cleared.
    let mut latest = read_sync_config(app);
    latest.synced = synced;
    for id in pushed_deletes {
        latest.tombstones.remove(&id);
    }
    write_sync_config(app, &latest)?;

    Ok(changed)
}

/// Run a sync pass in the background. Serialized by `SyncState` so passes never
/// overlap; emits `sync:status` (syncing/idle/error) and `sync:changed` when
/// something landed locally.
#[tauri::command]
async fn sync_now(app: AppHandle) -> Result<(), String> {
    // Silent no-op when sync isn't set up, so the launch-time call emits no status
    // for users who never configured it. Configured (URL + token) == syncing.
    let cfg = read_sync_config(&app);
    if cfg.url.is_empty() || cfg.token.is_empty() {
        return Ok(());
    }
    let state = app.state::<SyncState>();
    if state.running.swap(true, Ordering::SeqCst) {
        return Ok(()); // a sync is already in flight
    }
    let _ = app.emit("sync:status", serde_json::json!({ "state": "syncing" }));
    let result = sync_once(&app).await;
    app.state::<SyncState>().running.store(false, Ordering::SeqCst);
    match result {
        Ok(changed) => {
            if changed {
                let _ = app.emit("sync:changed", ());
            }
            let _ = app.emit(
                "sync:status",
                serde_json::json!({ "state": "idle", "at": now_ms() }),
            );
            Ok(())
        }
        Err(e) => {
            let _ = app.emit(
                "sync:status",
                serde_json::json!({ "state": "error", "message": e.clone() }),
            );
            Err(e)
        }
    }
}

/// The current store contents (visible drafts), for a post-sync UI refresh.
/// Unlike `init_store` it neither migrates nor prunes — it just reads.
#[tauri::command]
fn list_drafts(app: AppHandle) -> Result<Vec<Draft>, String> {
    let mut drafts = read_all_drafts(&app)?;
    drafts.retain(|d| !file_gone(d));
    Ok(drafts)
}

/// Ids of drafts present in the sync ledger (backed up to the cloud), for the
/// sidebar "synced" cloud marker. Empty when sync is unconfigured.
#[tauri::command]
fn synced_ids(app: AppHandle) -> Vec<String> {
    read_sync_config(&app).synced.into_keys().collect()
}

fn build_menu(app: &AppHandle) -> tauri::Result<()> {
    let about = MenuItemBuilder::with_id("about", "About Jotter").build(app)?;
    let app_menu = SubmenuBuilder::new(app, "Jotter")
        .item(&about)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let new = MenuItemBuilder::with_id("new", "New Draft")
        .accelerator("CmdOrCtrl+N")
        .build(app)?;
    let new_tab = MenuItemBuilder::with_id("new", "New Tab")
        .accelerator("CmdOrCtrl+T")
        .build(app)?;
    let open = MenuItemBuilder::with_id("open", "Open…")
        .accelerator("CmdOrCtrl+O")
        .build(app)?;
    let quick_open = MenuItemBuilder::with_id("switcher", "Quick Open…")
        .accelerator("CmdOrCtrl+P")
        .build(app)?;
    let save = MenuItemBuilder::with_id("save", "Save…")
        .accelerator("CmdOrCtrl+S")
        .build(app)?;
    let save_as = MenuItemBuilder::with_id("save_as", "Save As…")
        .accelerator("Shift+CmdOrCtrl+S")
        .build(app)?;
    let close_tab = MenuItemBuilder::with_id("close_tab", "Close Tab")
        .accelerator("CmdOrCtrl+W")
        .build(app)?;
    let reopen_tab = MenuItemBuilder::with_id("reopen_tab", "Reopen Closed Tab")
        .accelerator("Shift+CmdOrCtrl+T")
        .build(app)?;

    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&new)
        .item(&new_tab)
        .separator()
        .item(&open)
        .item(&quick_open)
        .separator()
        .item(&save)
        .item(&save_as)
        .separator()
        .item(&close_tab)
        .item(&reopen_tab)
        .build()?;

    let find = MenuItemBuilder::with_id("find", "Find…")
        .accelerator("CmdOrCtrl+F")
        .build(app)?;
    let find_next = MenuItemBuilder::with_id("find_next", "Find Next")
        .accelerator("CmdOrCtrl+G")
        .build(app)?;
    let find_prev = MenuItemBuilder::with_id("find_prev", "Find Previous")
        .accelerator("Shift+CmdOrCtrl+G")
        .build(app)?;
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .separator()
        .item(&find)
        .item(&find_next)
        .item(&find_prev)
        .build()?;

    let toggle_sidebar = MenuItemBuilder::with_id("toggle_sidebar", "Toggle Drafts Sidebar")
        .accelerator("CmdOrCtrl+B")
        .build(app)?;
    let toggle_preview = MenuItemBuilder::with_id("toggle_preview", "Toggle Markdown Preview")
        .accelerator("Shift+CmdOrCtrl+P")
        .build(app)?;
    let settings = MenuItemBuilder::with_id("settings", "Settings…")
        .accelerator("CmdOrCtrl+,")
        .build(app)?;
    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&toggle_sidebar)
        .item(&toggle_preview)
        .separator()
        .item(&settings)
        .build()?;

    // No accelerators here: Tab-based menu accelerators (Control+Tab) are
    // unreliable on macOS — AppKit swallows the key before the menu acts, so the
    // shortcut is handled in the webview (see the keydown handler in main.js).
    // Menu items stay for discoverability / click access.
    let prev_tab = MenuItemBuilder::with_id("prev_tab", "Show Previous Tab").build(app)?;
    let next_tab = MenuItemBuilder::with_id("next_tab", "Show Next Tab").build(app)?;
    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .fullscreen()
        .separator()
        .item(&prev_tab)
        .item(&next_tab)
        .build()?;

    let menu = MenuBuilder::new(app)
        .items(&[
            &app_menu,
            &file_menu,
            &edit_menu,
            &view_menu,
            &window_menu,
        ])
        .build()?;

    app.set_menu(menu)?;
    Ok(())
}

/// Persisted window size, in **logical** pixels.
#[derive(Serialize, Deserialize, Clone, Copy)]
struct WindowGeom {
    w: f64,
    h: f64,
}

// Keep in sync with `minWidth`/`minHeight` in tauri.conf.json.
const MIN_W: f64 = 480.0;
const MIN_H: f64 = 320.0;

fn geom_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_dir(app)?.join("window.json"))
}

/// Size the window to the saved size (or a monitor-proportional default on first
/// run), clamp it to `[min, monitor]`, then center and show it.
///
/// Everything is in **logical** pixels so the save→restore round-trip is
/// idempotent (`L → set_size(L) → inner_size = L·scale → /scale = L`). That's what
/// avoids the progressive-shrink bug `tauri-plugin-window-state` had on HiDPI
/// displays, where a physical/logical mismatch lost pixels every cycle.
fn restore_window(app: &AppHandle) {
    use tauri::{LogicalSize, PhysicalSize};
    let Some(win) = app.get_webview_window("main") else {
        return;
    };

    // Current monitor's logical size (generous fallback if it can't be read).
    let (mw, mh) = match win.current_monitor() {
        Ok(Some(m)) => {
            let s = m.scale_factor();
            let PhysicalSize { width, height } = *m.size();
            (width as f64 / s, height as f64 / s)
        }
        _ => (f64::MAX, f64::MAX),
    };

    // Saved size, else a comfortable fraction of the monitor.
    let saved = geom_file(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<WindowGeom>(&s).ok());
    let (mut w, mut h) = match saved {
        Some(g) => (g.w, g.h),
        None => (
            (mw * 0.68).clamp(760.0, 1280.0),
            (mh * 0.80).clamp(560.0, 900.0),
        ),
    };

    // Never tiny, never larger than the screen.
    w = w.clamp(MIN_W, mw.max(MIN_W));
    h = h.clamp(MIN_H, mh.max(MIN_H));

    let _ = win.set_size(LogicalSize::new(w, h));
    let _ = win.center();
    let _ = win.show();
}

/// Save the window's current size (logical) so the next launch restores it.
fn save_window(win: &tauri::WebviewWindow) {
    let scale = win.scale_factor().unwrap_or(1.0);
    if let Ok(size) = win.inner_size() {
        let geom = WindowGeom {
            w: size.width as f64 / scale,
            h: size.height as f64 / scale,
        };
        if let (Ok(path), Ok(json)) = (geom_file(win.app_handle()), serde_json::to_string(&geom)) {
            let _ = fs::write(path, json);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(SyncState {
            running: AtomicBool::new(false),
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
            build_menu(app.handle())?;
            restore_window(app.handle());
            Ok(())
        })
        .on_menu_event(|app, event| {
            let id = event.id().0.as_str();
            if matches!(
                id,
                "new" | "open"
                    | "save"
                    | "save_as"
                    | "close_tab"
                    | "reopen_tab"
                    | "switcher"
                    | "next_tab"
                    | "prev_tab"
                    | "find"
                    | "find_next"
                    | "find_prev"
                    | "toggle_sidebar"
                    | "toggle_preview"
                    | "settings"
                    | "about"
            ) {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.emit("menu", id);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            init_store,
            save_draft,
            delete_draft,
            read_text_file,
            write_text_file,
            set_sync_config,
            get_sync_config,
            get_sync_token,
            sync_test_connection,
            sync_now,
            list_drafts,
            synced_ids
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| match event {
            // Persist the window size when it closes or the app quits, so the next
            // launch restores it (see restore_window / save_window).
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::CloseRequested { .. },
                ..
            } => {
                if let Some(win) = app_handle.get_webview_window(&label) {
                    save_window(&win);
                }
            }
            tauri::RunEvent::ExitRequested { .. } => {
                if let Some(win) = app_handle.get_webview_window("main") {
                    save_window(&win);
                }
            }
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn draft(content: &str, file_path: Option<&str>) -> Draft {
        Draft {
            content: content.to_string(),
            file_path: file_path.map(String::from),
            ..Default::default()
        }
    }

    #[test]
    fn orphan_is_empty_and_unnamed() {
        assert!(is_orphan(&draft("   \n\t", None)));
        assert!(!is_orphan(&draft("", Some("/tmp/a.txt")))); // named counts
        assert!(!is_orphan(&draft("hello", None))); // has text
    }

    #[test]
    fn file_gone_flags_missing_backing_files() {
        assert!(file_gone(&draft("note", Some("/no/such/path-xyz-123.txt"))));
        assert!(!file_gone(&draft("note", None))); // unsaved draft isn't "gone"
    }

    #[test]
    fn draft_deserializes_with_defaults() {
        let d: Draft = serde_json::from_str(r#"{"id":"a"}"#).unwrap();
        assert_eq!(d.id, "a");
        assert_eq!(d.content, "");
        assert!(d.file_path.is_none());
        assert_eq!(d.updated_at, 0);
    }

    #[test]
    fn draft_round_trips_through_json() {
        let d = draft("note body", Some("/tmp/n.txt"));
        let json = serde_json::to_string(&d).unwrap();
        let back: Draft = serde_json::from_str(&json).unwrap();
        assert_eq!(back.content, "note body");
        assert_eq!(back.file_path.as_deref(), Some("/tmp/n.txt"));
    }

    // --- sync config ---

    fn cfg_with_token(token: &str) -> SyncConfig {
        SyncConfig {
            enabled: false,
            url: "https://old.example".into(),
            token: token.into(),
            synced: HashMap::from([("draft-a".into(), 5)]),
            tombstones: HashMap::from([("draft-b".into(), 9)]),
        }
    }

    #[test]
    fn update_preserves_token_when_none() {
        let out = apply_config_update(cfg_with_token("secret"), true, "https://new.example".into(), None);
        assert_eq!(out.token, "secret"); // token untouched
        assert!(out.enabled);
        assert_eq!(out.url, "https://new.example");
    }

    #[test]
    fn update_preserves_token_when_empty_string() {
        let out = apply_config_update(cfg_with_token("secret"), false, "https://x".into(), Some(String::new()));
        assert_eq!(out.token, "secret");
    }

    #[test]
    fn update_replaces_token_when_supplied() {
        let out = apply_config_update(cfg_with_token("old"), false, "https://x".into(), Some("new".into()));
        assert_eq!(out.token, "new");
    }

    #[test]
    fn update_preserves_sync_ledger() {
        let out = apply_config_update(cfg_with_token("t"), true, "https://x".into(), None);
        assert_eq!(out.synced.get("draft-a"), Some(&5));
        assert_eq!(out.tombstones.get("draft-b"), Some(&9));
    }

    #[test]
    fn update_normalizes_trailing_slashes() {
        let out = apply_config_update(SyncConfig::default(), false, "  https://x.example///  ".into(), None);
        assert_eq!(out.url, "https://x.example");
    }

    #[test]
    fn sync_config_deserializes_from_empty_and_legacy() {
        let empty: SyncConfig = serde_json::from_str("{}").unwrap();
        assert!(!empty.enabled && empty.token.is_empty() && empty.synced.is_empty());
        // Legacy file missing synced/tombstones still loads.
        let legacy: SyncConfig =
            serde_json::from_str(r#"{"enabled":true,"url":"https://y","token":"tok"}"#).unwrap();
        assert!(legacy.enabled);
        assert_eq!(legacy.token, "tok");
        assert!(legacy.tombstones.is_empty());
    }

    #[test]
    fn needs_push_when_newer_or_never_synced() {
        assert!(needs_push(10, None)); // never synced -> push
        assert!(needs_push(10, Some(5))); // edited since last sync -> push
        assert!(!needs_push(10, Some(10))); // already in sync -> skip
        assert!(!needs_push(5, Some(10))); // remote ahead -> skip (pull handles it)
    }

    #[test]
    fn normalize_url_trims_space_and_trailing_slashes() {
        assert_eq!(normalize_url("  https://x.example///  "), "https://x.example");
        assert_eq!(normalize_url("https://x.example"), "https://x.example");
        assert_eq!(normalize_url(""), "");
    }

    #[test]
    fn view_hides_token_but_reports_presence() {
        let view = SyncConfigView {
            enabled: cfg_with_token("secret").enabled,
            url: cfg_with_token("secret").url,
            has_token: !cfg_with_token("secret").token.is_empty(),
        };
        let json = serde_json::to_string(&view).unwrap();
        assert!(!json.contains("secret"));
        assert!(json.contains("\"has_token\":true"));
    }
}

