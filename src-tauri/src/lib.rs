use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
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
    // Sidebar pin. Synced across devices (it rides the draft JSON through R2), so
    // `#[serde(default)]` keeps older stored/remote drafts loading as unpinned.
    #[serde(default)]
    pinned: bool,
    // Opt-in cloud sync for a file-backed draft. Files opened from disk are
    // device-local by default (the on-disk file is their source of truth, and
    // `file_path` never leaves the machine), so their content isn't pushed unless
    // the user explicitly turns this on. Ignored for in-app drafts, which always
    // sync. `#[serde(default)]` keeps older/remote drafts loading as opt-out.
    #[serde(default)]
    cloud: bool,
    // Modification time of `file_path` as of the last read or write this device
    // made, in ms. Used to notice that something else changed the file since —
    // see `save_draft`. Device-local like `file_path`, so it is scrubbed before
    // a push.
    #[serde(default)]
    file_mtime: Option<i64>,
}

/// A file's modification time in ms, or None if it cannot be read.
fn mtime_ms(path: &str) -> Option<i64> {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
}

/// Commands return `Result<_, String>` because that is what crosses the IPC
/// boundary; every fallible std/serde/reqwest call funnels through here.
fn msg(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// The one window, wherever an `AppHandle` or the `App` itself is at hand.
fn main_window(m: &impl Manager<tauri::Wry>) -> Option<tauri::WebviewWindow> {
    m.get_webview_window("main")
}

fn is_json(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()) == Some("json")
}

fn path_str(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl Draft {
    /// A fresh in-app draft; every flag at its default.
    fn new(id: String, content: String, file_path: Option<String>, now: i64) -> Self {
        Draft {
            id,
            content,
            file_path,
            created_at: now,
            updated_at: now,
            ..Default::default()
        }
    }
}

/// An "orphan" draft has nothing in it worth keeping — no text, no on-disk
/// file, and no name the user gave it — so it is safe to prune on load.
///
/// The title matters: a draft that was renamed and then cleared out is still
/// something the user made deliberately, and pruning it on the next launch
/// would lose it. Keep in step with `isEmpty` in lib/text.js.
fn is_orphan(d: &Draft) -> bool {
    d.content.trim().is_empty() && d.file_path.is_none() && d.title.trim().is_empty()
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
    // The E2E binary is pointed at a throwaway folder so a test run can never
    // touch the notes of whoever runs it.
    #[cfg(feature = "e2e")]
    if let Ok(dir) = std::env::var("JOTTER_DATA_DIR") {
        let dir = PathBuf::from(dir);
        fs::create_dir_all(&dir).map_err(msg)?;
        return Ok(dir);
    }
    let dir = app.path().app_data_dir().map_err(msg)?;
    fs::create_dir_all(&dir).map_err(msg)?;
    Ok(dir)
}

/// Where the drafts store lives when the user has not moved it.
fn default_drafts_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_dir(app)?.join("drafts"))
}

fn store_config_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_dir(app)?.join("store.json"))
}

#[derive(Serialize, Deserialize, Default)]
struct StoreConfig {
    /// Absolute path to the drafts folder. `None` means the default location.
    dir: Option<String>,
}

fn read_store_config(app: &AppHandle) -> StoreConfig {
    read_json(store_config_file(app))
}

/// The drafts store. Honours a user-chosen folder — which is what makes it
/// possible to point the store at a Syncthing/Dropbox directory — and falls back
/// to the default if that folder has gone away (an unmounted volume, say), so a
/// missing external disk degrades to an empty store instead of an error on boot.
fn drafts_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(custom) = read_store_config(app).dir {
        let dir = PathBuf::from(custom);
        if fs::create_dir_all(&dir).is_ok() {
            return Ok(dir);
        }
    }
    let dir = default_drafts_dir(app)?;
    fs::create_dir_all(&dir).map_err(msg)?;
    Ok(dir)
}

/// The configured drafts folder, whether it is the default one, and whether it
/// can be reached right now.
///
/// Deliberately reports the *configured* path rather than the one in use: when
/// a custom folder is unavailable (an unmounted disk, say) `drafts_dir` falls
/// back to the default so the app still runs, and showing the default here
/// would hide the fact that new drafts are landing somewhere the user is not
/// expecting.
#[tauri::command]
fn get_drafts_dir(app: AppHandle) -> Result<(String, bool, bool), String> {
    match read_store_config(&app).dir {
        Some(dir) => {
            let available = fs::create_dir_all(&dir).is_ok();
            Ok((dir, false, available))
        }
        None => Ok((path_str(&default_drafts_dir(&app)?), true, true)),
    }
}

/// Move the drafts store to `dir` (or back to the default when `dir` is None).
/// Existing `*.json` drafts are copied over first; a name that already exists at
/// the destination is left alone, so pointing two Macs at one synced folder
/// merges rather than overwrites.
#[tauri::command]
fn set_drafts_dir(app: AppHandle, dir: Option<String>) -> Result<String, String> {
    let from = drafts_dir(&app)?;
    let to = match &dir {
        Some(d) => PathBuf::from(d),
        None => default_drafts_dir(&app)?,
    };
    fs::create_dir_all(&to).map_err(msg)?;

    if from != to {
        for entry in fs::read_dir(&from).map_err(msg)?.flatten() {
            let path = entry.path();
            if !is_json(&path) {
                continue;
            }
            let Some(name) = path.file_name() else {
                continue;
            };
            let target = to.join(name);
            if target.exists() {
                continue;
            }
            // Copy-then-remove rather than rename: the destination is often on a
            // different volume, where rename fails with a cross-device error.
            if fs::copy(&path, &target).is_ok() {
                let _ = fs::remove_file(&path);
            }
        }
    }

    let cfg = StoreConfig {
        dir: if to == default_drafts_dir(&app)? {
            None
        } else {
            Some(path_str(&to))
        },
    };
    write_json(&store_config_file(&app)?, &cfg)?;
    Ok(path_str(&to))
}

// Directory-based store primitives — take a plain `dir` so the sync engine can be
// driven against a tempdir in tests. The `app`-based wrappers below resolve the
// real drafts dir and delegate.

fn draft_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.json"))
}

/// Read the whole store: one file per draft, parsed in parallel.
///
/// This is on the launch path, and a store is many small files — the cost is
/// almost all per-file latency, not bytes, so the reads are split across a few
/// threads instead of waiting for each in turn. Order is restored by the caller
/// (`read_all_drafts` sorts), so the split does not have to be stable.
fn read_all_drafts_in(dir: &Path) -> Result<Vec<Draft>, String> {
    let paths: Vec<PathBuf> = fs::read_dir(dir)
        .map_err(msg)?
        .flatten()
        .map(|e| e.path())
        .filter(|p| is_json(p))
        .collect();

    let lanes = std::thread::available_parallelism()
        .map(|n| n.get().min(8))
        .unwrap_or(4)
        .min(paths.len().max(1));
    if lanes < 2 {
        return Ok(paths.iter().filter_map(|p| parse_draft(p)).collect());
    }

    let chunk = paths.len().div_ceil(lanes);
    let mut out = Vec::with_capacity(paths.len());
    std::thread::scope(|scope| {
        let handles: Vec<_> = paths
            .chunks(chunk)
            .map(|part| {
                scope.spawn(move || {
                    part.iter()
                        .filter_map(|p| parse_draft(p))
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        for h in handles {
            // A panic in a lane is a bug, not a store the user can fix; the
            // empty result keeps the rest of the store readable.
            out.extend(h.join().unwrap_or_default());
        }
    });
    Ok(out)
}

/// One stored entry, or nothing when the file is unreadable or not a draft.
/// A damaged file is skipped rather than failing the whole launch.
fn parse_draft(path: &Path) -> Option<Draft> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str::<Draft>(&text).ok()
}

/// Write `contents` to `path` without ever leaving it half-written.
///
/// `fs::write` truncates the target and then streams into it, so a crash, a
/// full disk, or a sync client reading mid-write can see a truncated file. For
/// an app whose promise is that nothing is lost, that is the wrong trade. Write
/// a temp file beside the target instead and rename over it: rename is atomic
/// within a filesystem, so a reader sees either the old file or the new one.
///
/// The temp file is a sibling on purpose — a rename across filesystems fails,
/// and the target's own directory is the only place guaranteed to be on the
/// same one.
fn write_atomic(path: &Path, contents: &[u8]) -> Result<(), String> {
    let dir = path.parent().ok_or("path has no parent directory")?;
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("path has no file name")?;
    let tmp = dir.join(format!(".{name}.{}.tmp", std::process::id()));

    let write = || -> std::io::Result<()> {
        let mut f = fs::File::create(&tmp)?;
        std::io::Write::write_all(&mut f, contents)?;
        f.sync_all()?; // the bytes must be on disk before the rename points at them
                       // Rename replaces the inode, so a file the user made read-only for
                       // others, or executable, would come back with default bits. Carry the
                       // old mode over; a target that does not exist yet keeps the default.
        if let Ok(meta) = fs::metadata(path) {
            let _ = fs::set_permissions(&tmp, meta.permissions());
        }
        Ok(())
    };
    if let Err(e) = write() {
        let _ = fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    Ok(())
}

/// Read a JSON file into `T`, or `T::default()` when it is missing, unreadable
/// or not valid JSON. Every config file in app_data_dir is read this way: a
/// partial or older file still loads thanks to `#[serde(default)]` on the
/// structs, and a corrupt one degrades to defaults rather than an error on boot.
fn read_json<T: serde::de::DeserializeOwned + Default>(path: Result<PathBuf, String>) -> T {
    path.ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Write `value` as pretty JSON, atomically.
fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let json = serde_json::to_string_pretty(value).map_err(msg)?;
    write_atomic(path, json.as_bytes())
}

/// Write a draft's store entry, and its backing file when it has one.
///
/// The text file goes first so its new mtime can be recorded in the stored
/// entry: that is what a later save compares against to notice an outside edit.
/// Writing the entry first would leave it describing the file as it was before,
/// and every sync pull would then look like a conflict. Dying between the two
/// leaves a stale mtime, which errs towards asking rather than overwriting.
fn write_draft_in(dir: &Path, draft: &Draft) -> Result<Option<i64>, String> {
    let mut d = draft.clone();
    if let Some(fp) = &d.file_path {
        write_atomic(Path::new(fp), d.content.as_bytes())?;
        d.file_mtime = mtime_ms(fp);
    }
    write_entry_in(dir, &d)?;
    Ok(d.file_mtime)
}

/// Write only the store entry, leaving the backing text file alone. For fixes
/// to the entry itself (a path spelled differently), where writing the file
/// would risk putting stale content over a newer copy on disk.
fn write_entry_in(dir: &Path, draft: &Draft) -> Result<(), String> {
    let json = serde_json::to_string_pretty(draft).map_err(msg)?;
    write_atomic(&draft_path(dir, &draft.id), json.as_bytes())
}

fn draft_file(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    Ok(draft_path(&drafts_dir(app)?, id))
}

fn read_all_drafts(app: &AppHandle) -> Result<Vec<Draft>, String> {
    let mut out = read_all_drafts_in(&drafts_dir(app)?)?;
    out.sort_by_key(|d| std::cmp::Reverse(d.updated_at));
    Ok(out)
}

/// Read a single draft from the store by id (O(1), vs scanning the whole store).
fn read_draft(app: &AppHandle, id: &str) -> Option<Draft> {
    draft_file(app, id)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<Draft>(&s).ok())
}

fn write_draft(app: &AppHandle, draft: &Draft) -> Result<Option<i64>, String> {
    write_draft_in(&drafts_dir(app)?, draft)
}

/// All saved drafts, newest first. Migrates the legacy single-session file once.
/// True only in the E2E build. The page uses it to expose a test hook.
#[tauri::command]
fn is_e2e() -> bool {
    cfg!(feature = "e2e")
}

#[tauri::command]
fn init_store(app: AppHandle) -> Result<Vec<Draft>, String> {
    let mut drafts = read_all_drafts(&app)?;
    // A file already in the store was chosen by the user in some past run.
    allow_drafts(&app, &drafts);

    // Paths stored before opens were canonicalised may be spelled differently
    // from what an open produces now (`/tmp` vs `/private/tmp`, a symlinked
    // folder), which would open the same file in a second tab. Fix the entry
    // once; the text file is not touched.
    let dir = drafts_dir(&app)?;
    for d in drafts.iter_mut() {
        if let Some(fp) = &d.file_path {
            let fixed = canonical(fp);
            if fixed != *fp {
                d.file_path = Some(fixed);
                let _ = write_entry_in(&dir, d);
            }
        }
    }

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
                let draft = Draft::new(format!("draft-{now}"), content.to_string(), file_path, now);
                write_draft(&app, &draft)?;
                drafts.push(draft);
            }
            let _ = fs::remove_file(&legacy);
        }
    }

    Ok(drafts)
}

/// Whether a save must be refused because the backing file moved on underneath.
///
/// Only a mismatch between two known times counts. No recorded time means the
/// caller has said "write regardless"; an unreadable current time means the
/// file is gone or unreachable, and refusing there would strand the user's text
/// with nowhere to put it.
fn is_conflict(seen: Option<i64>, current: Option<i64>) -> bool {
    matches!((seen, current), (Some(s), Some(c)) if s != c)
}

/// Sentinel the frontend matches on to offer reload-or-keep.
const CONFLICT: &str = "conflict";

/// Upsert a draft: write its store file and (if named) the on-disk text file.
///
/// Refuses to write when the backing file changed underneath us — the draft
/// carries the mtime it last saw, and anything else means another program (an
/// editor, a sync client) has written since. Autosave fires 400 ms after a
/// keystroke, so without this the app would silently overwrite that work. A
/// draft with no recorded mtime is written unconditionally, which is how the
/// frontend says "keep mine".
///
/// Returns the file's mtime after the write, for the caller to hold on to.
#[tauri::command]
fn save_draft(app: AppHandle, draft: Draft) -> Result<Option<i64>, String> {
    if let Some(path) = draft.file_path.as_deref() {
        check_allowed(&app, path)?;
        if is_conflict(draft.file_mtime, mtime_ms(path)) {
            return Err(CONFLICT.to_string());
        }
    }
    let mtime = write_draft(&app, &draft)?;
    // A re-saved draft is no longer deleted — but only if it is one that syncs.
    // A file draft opted back out has a tombstone waiting to remove its remote
    // copy, and clearing that on every autosave would strand it in the cloud.
    if syncs_to_cloud(&draft) {
        clear_tombstone(&app, &draft.id);
    }
    Ok(mtime)
}

/// Store entry only, the text file untouched. For a file the user just opened:
/// the store has to learn about it now, but rewriting an unedited file would
/// look like an edit to a sync client and bump its mtime for nothing.
#[tauri::command]
fn save_entry(app: AppHandle, draft: Draft) -> Result<(), String> {
    write_entry_in(&drafts_dir(&app)?, &draft)
}

/// Read one stored entry, change it, write it back — entry only, the text
/// file is never touched. For changes to what the store knows about a note
/// (its name, its pin, its cloud flag) rather than to the note itself, where
/// writing the file would put whatever content the store holds over a copy
/// on disk that may be newer.
fn update_entry_in(dir: &Path, id: &str, change: impl FnOnce(&mut Draft)) -> Result<Draft, String> {
    let path = draft_path(dir, id);
    let text = fs::read_to_string(&path).map_err(msg)?;
    let mut d: Draft = serde_json::from_str(&text).map_err(msg)?;
    change(&mut d);
    write_entry_in(dir, &d)?;
    Ok(d)
}

/// Flip a stored draft's `cloud` flag, entry only.
fn set_cloud_in(dir: &Path, id: &str, on: bool) -> Result<Draft, String> {
    update_entry_in(dir, id, |d| d.cloud = on)
}

/// Rename or pin a stored draft without touching its text file. Errs when the
/// draft is not in the store yet (typed but not autosaved), and the caller
/// falls back to a full save.
#[tauri::command]
fn save_meta(
    app: AppHandle,
    id: String,
    title: String,
    pinned: bool,
    updated_at: i64,
) -> Result<(), String> {
    let d = update_entry_in(&drafts_dir(&app)?, &id, |d| {
        d.title = title;
        d.pinned = pinned;
        d.updated_at = updated_at;
    })?;
    if syncs_to_cloud(&d) {
        clear_tombstone(&app, &id); // a re-saved draft is no longer deleted
    }
    Ok(())
}

/// Opt a file-backed draft into or out of cloud sync, and settle its tombstone
/// in the same step: opting out records one so the next sync removes the copy
/// already on the worker (turning the flag off alone would leave the note up
/// there), and opting in clears any that is pending. One command, so a failure
/// cannot leave the flag and the tombstone disagreeing.
#[tauri::command]
fn set_cloud(app: AppHandle, id: String, on: bool) -> Result<(), String> {
    set_cloud_in(&drafts_dir(&app)?, &id, on)?;
    if on {
        clear_tombstone(&app, &id);
    } else {
        record_tombstone(&app, &id);
    }
    Ok(())
}

#[tauri::command]
fn delete_draft(app: AppHandle, id: String) -> Result<(), String> {
    let path = draft_file(&app, &id)?;
    if path.exists() {
        fs::remove_file(path).map_err(msg)?;
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

/// Build the name for a conflicted copy: `notes.md` -> `notes (conflicted copy).md`.
/// Pure so the naming is tested without touching a disk.
fn conflict_copy_path(path: &Path) -> PathBuf {
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned());
    match (stem, path.extension()) {
        (Some(stem), Some(ext)) => path.with_file_name(format!(
            "{stem} (conflicted copy).{}",
            ext.to_string_lossy()
        )),
        (Some(stem), None) => path.with_file_name(format!("{stem} (conflicted copy)")),
        _ => path.with_extension("conflicted"),
    }
}

/// Park the editor's text beside the file it could not be written to.
///
/// When a save is refused because the file changed underneath, the user's text
/// exists only in the textarea. Quitting there loses it, and so does switching
/// tabs, since that re-reads from disk. Writing it out at the moment the
/// conflict is noticed means neither can, whatever the user does next.
/// Returns the path written, for the message.
#[tauri::command]
fn write_conflict_copy(app: AppHandle, path: String, contents: String) -> Result<String, String> {
    check_allowed(&app, &path)?;
    let target = conflict_copy_path(Path::new(&path));
    write_atomic(&target, contents.as_bytes())?;
    Ok(path_str(&target))
}

/// Reveal the drafts folder in the system file manager.
///
/// Goes through the plugin's Rust API rather than the webview's `openPath`:
/// that command is scope-checked, and with no `allow` entries the check refuses
/// every path. Granting the webview a wildcard path scope to open one known
/// folder is the wrong trade, so the folder is opened from here instead — the
/// webview never names a path at all.
#[tauri::command]
fn open_drafts_dir(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = drafts_dir(&app)?;
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(msg)
}

// --- What the page may touch on disk ----------------------------------------
//
// `read_text_file`, `write_text_file` and `save_draft` take a path from the
// webview, so a page running someone else's script could name any file on the
// machine. The host therefore keeps the set of paths the *user* chose — a file
// dialog, a drop on the window, "Open With", the command line, or a file the
// store already tracks — and refuses every other path. The set lives for one
// run and is never persisted: nothing the page says can add to it, which is why
// the dialogs are opened from here rather than from the webview.
#[derive(Default)]
struct Allowed(Mutex<HashSet<String>>);

const DENIED: &str = "that file was not opened by the user";

/// Record a path the user chose. Held canonical, so the check matches however
/// the page later spells the same file.
fn allow_in(set: &Allowed, path: &str) {
    set.0.lock().unwrap().insert(canonical(path));
}

fn check_in(set: &Allowed, path: &str) -> Result<(), String> {
    if set.0.lock().unwrap().contains(&canonical(path)) {
        Ok(())
    } else {
        Err(DENIED.to_string())
    }
}

fn allow_path(app: &AppHandle, path: &str) {
    if let Some(state) = app.try_state::<Allowed>() {
        allow_in(&state, path);
    }
}

fn allow_drafts(app: &AppHandle, drafts: &[Draft]) {
    for p in drafts.iter().filter_map(|d| d.file_path.as_deref()) {
        allow_path(app, p);
    }
}

fn check_allowed(app: &AppHandle, path: &str) -> Result<(), String> {
    let state = app.try_state::<Allowed>().ok_or(DENIED)?;
    check_in(&state, path)
}

/// One entry of a dialog's file-type filter, in the shape the page already uses.
#[derive(Deserialize)]
struct Filter {
    name: String,
    extensions: Vec<String>,
}

fn with_filters(
    mut builder: tauri_plugin_dialog::FileDialogBuilder<tauri::Wry>,
    filters: &[Filter],
) -> tauri_plugin_dialog::FileDialogBuilder<tauri::Wry> {
    for f in filters {
        let exts: Vec<&str> = f.extensions.iter().map(String::as_str).collect();
        builder = builder.add_filter(&f.name, &exts);
    }
    builder
}

/// Run a file dialog off the async runtime and wait for the answer.
///
/// The blocking variants of the plugin's API panic when called from the main
/// thread, which is where a non-async command runs, so the dialog is opened
/// with the callback API and the reply comes back over a channel.
async fn ask_for_path(
    open: impl FnOnce(std::sync::mpsc::Sender<Option<tauri_plugin_dialog::FilePath>>) + Send + 'static,
) -> Option<String> {
    let (tx, rx) = std::sync::mpsc::channel();
    open(tx);
    let picked = tauri::async_runtime::spawn_blocking(move || rx.recv().ok().flatten())
        .await
        .ok()??;
    picked.into_path().ok().map(|p| path_str(&p))
}

/// File > Open. The picked file becomes readable; nothing else does.
#[tauri::command]
async fn pick_file(app: AppHandle, filters: Vec<Filter>) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let dialog = with_filters(app.dialog().clone().file(), &filters);
    let path = ask_for_path(move |tx| {
        dialog.pick_file(move |p| {
            let _ = tx.send(p);
        })
    })
    .await?;
    allow_path(&app, &path);
    Some(path)
}

/// Save As and Export. The chosen name becomes writable, and stays writable for
/// the rest of the run so later autosaves of that draft go through.
#[tauri::command]
async fn pick_save_path(
    app: AppHandle,
    default_path: Option<String>,
    filters: Vec<Filter>,
) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let mut dialog = with_filters(app.dialog().clone().file(), &filters);
    if let Some(d) = default_path.as_deref() {
        let p = Path::new(d);
        if let Some(name) = p.file_name() {
            dialog = dialog.set_file_name(name.to_string_lossy());
        }
        if let Some(dir) = p.parent().filter(|d| !d.as_os_str().is_empty()) {
            dialog = dialog.set_directory(dir);
        }
    }
    let path = ask_for_path(move |tx| {
        dialog.save_file(move |p| {
            let _ = tx.send(p);
        })
    })
    .await?;
    allow_path(&app, &path);
    Some(path)
}

/// Settings > Drafts folder. A folder is not a file the page can read, so this
/// one grants nothing.
#[tauri::command]
async fn pick_folder(app: AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let dialog = app.dialog().clone().file();
    ask_for_path(move |tx| {
        dialog.pick_folder(move |p| {
            let _ = tx.send(p);
        })
    })
    .await
}

/// Resolve a path to its canonical form: symlinks followed, `.`/`..` removed,
/// and on macOS `/tmp` expanded to `/private/tmp`.
///
/// The frontend decides whether a file is already open by comparing paths as
/// strings, and the OS hands the same file over by different names depending on
/// how it was opened — a dialog, a drop, "Open With", the command line. Without
/// this the same file opens in two tabs that then overwrite each other.
///
/// A file that does not exist yet (Save As names one before the first write)
/// gets its directory resolved and its name kept, so the stored path matches
/// what a later open of that file will produce. A path that cannot be resolved
/// at all is returned unchanged, so a file that has since gone still reaches
/// the caller's own error handling.
fn canonical(path: &str) -> String {
    let p = Path::new(path);
    let resolved = match fs::canonicalize(p) {
        Ok(r) => r,
        Err(_) => match (p.parent(), p.file_name()) {
            (Some(dir), Some(name)) if !dir.as_os_str().is_empty() => match fs::canonicalize(dir) {
                Ok(d) => d.join(name),
                Err(_) => return path.to_string(),
            },
            _ => return path.to_string(),
        },
    };
    strip_verbatim(path_str(&resolved))
}

/// Undo the `\\?\` verbatim prefix Windows' `canonicalize` adds (`\\?\C:\...`,
/// `\\?\UNC\server\share\...`). Nothing else in the app or in the OS dialogs
/// uses that form, so a path carrying it would never match one that does not,
/// and it reads as line noise in the sidebar. Pure, so it is tested on every OS.
fn strip_verbatim(s: String) -> String {
    match s.strip_prefix(r"\\?\") {
        Some(rest) => match rest.strip_prefix(r"UNC\") {
            Some(unc) => format!(r"\\{unc}"),
            None => rest.to_string(),
        },
        None => s,
    }
}

#[tauri::command]
fn canonical_path(path: String) -> String {
    canonical(&path)
}

/// A file's contents and its modification time, so the caller can tell later
/// whether anything else has written to it.
#[tauri::command]
fn read_text_file(app: AppHandle, path: String) -> Result<(String, Option<i64>), String> {
    check_allowed(&app, &path)?;
    let text = fs::read_to_string(&path).map_err(msg)?;
    Ok((text, mtime_ms(&path)))
}

/// Write text to an arbitrary path the user picked (used by Export). Unlike
/// `save_draft`, this doesn't touch the draft's own file_path.
#[tauri::command]
fn write_text_file(app: AppHandle, path: String, contents: String) -> Result<(), String> {
    check_allowed(&app, &path)?;
    write_atomic(Path::new(&path), contents.as_bytes())
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

impl SyncConfig {
    /// The worker to talk to, as `(base_url, token)`, or None until both are
    /// set. Configured means syncing: there is no separate enable flag.
    fn endpoint(&self) -> Option<(String, &str)> {
        if self.url.is_empty() || self.token.is_empty() {
            return None;
        }
        Some((normalize_url(&self.url), &self.token))
    }
}

/// What the settings UI is allowed to see — the token is deliberately omitted.
#[derive(Serialize)]
struct SyncConfigView {
    enabled: bool,
    url: String,
    has_token: bool,
}

/// Result of a `/health` probe. `ok` is true only on HTTP 200; `status` lets the
/// UI distinguish 401 (bad token) from other failures. `configured` comes from the
/// public `/version` and is `Some(false)` when the worker has no `SYNC_TOKEN` set
/// (it fails closed), so a 401 means "set your token", not "wrong token".
#[derive(Serialize)]
struct TestResult {
    ok: bool,
    status: u16,
    version: Option<String>,
    configured: Option<bool>,
}

fn sync_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_dir(app)?.join("sync.json"))
}

fn read_sync_config(app: &AppHandle) -> SyncConfig {
    read_json(sync_file(app))
}

fn write_sync_config(app: &AppHandle, cfg: &SyncConfig) -> Result<(), String> {
    let path = sync_file(app)?;
    write_json(&path, cfg)?;
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

/// Whether a worker URL is safe to send the sync token to.
///
/// Every request carries the token as a bearer header, so plain http would put
/// it on the wire in cleartext for anything on the path to read. localhost is
/// allowed because it never leaves the machine, which keeps a self-hosted
/// worker testable with `wrangler dev`.
fn is_safe_worker_url(url: &str) -> bool {
    let u = normalize_url(url);
    if u.is_empty() {
        return true; // nothing configured yet
    }
    if u.starts_with("https://") {
        return true;
    }
    let Some(rest) = u.strip_prefix("http://") else {
        return false; // no scheme, or something that is not http(s)
    };
    // An IPv6 literal is bracketed and contains colons, so it has to be cut
    // out before splitting on ':' for the port.
    let host = match rest.strip_prefix('[') {
        Some(v6) => v6.split(']').next().unwrap_or(""),
        None => rest.split(['/', ':']).next().unwrap_or(""),
    };
    matches!(host, "localhost" | "127.0.0.1" | "::1")
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
    if !is_safe_worker_url(&url) {
        return Err(
            "The worker URL must start with https://. Every request carries your \
                    sync token, and plain http would send it in the clear."
                .into(),
        );
    }
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
    let client = http_client();
    let resp = client
        .get(format!("{base}/health"))
        .bearer_auth(token)
        .send()
        .await
        .map_err(msg)?;
    let status = resp.status().as_u16();
    let version = if status == 200 {
        resp.json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|v| v.get("version").and_then(|x| x.as_str()).map(String::from))
    } else {
        None
    };
    // A 200 already proves the token is set. On any rejection, ask the public
    // `/version` whether the worker even has a `SYNC_TOKEN` — so the UI can say
    // "worker has no token set" instead of blaming the user's token.
    let configured = if status == 200 {
        Some(true)
    } else {
        match client.get(format!("{base}/version")).send().await {
            Ok(r) => r
                .json::<serde_json::Value>()
                .await
                .ok()
                .and_then(|v| v.get("configured").and_then(|x| x.as_bool())),
            Err(_) => None,
        }
    };
    Ok(TestResult {
        ok: status == 200,
        status,
        version,
        configured,
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

/// Whether a draft's content is allowed to leave this machine. In-app notes (no
/// backing file) always sync — the cloud is their home. Files opened from disk are
/// device-local unless the user explicitly opted them in (`cloud`), since the file
/// itself is the source of truth. Pure, so it's unit-tested.
fn syncs_to_cloud(d: &Draft) -> bool {
    d.file_path.is_none() || d.cloud
}

/// Adopt a remote draft only when it's STRICTLY newer than the local copy — a tie
/// (same `updated_at`) means we already have it, so don't re-fetch.
fn remote_supersedes(remote_updated: i64, local_updated: i64) -> bool {
    remote_updated > local_updated
}

/// A remote deletion wins unless the local copy was edited AFTER the delete. A tie
/// (local == remote) lets the delete win, so a delete and a same-instant edit
/// converge to "deleted" across devices.
fn delete_wins(local_updated: i64, remote_deleted_at: i64) -> bool {
    local_updated <= remote_deleted_at
}

/// Run a full sync pass. Returns whether anything changed on disk locally (so the
/// UI can refresh). No-op (Ok(false)) when sync is disabled or unconfigured. Thin
/// wrapper: resolve config + store dir, run the pure-ish `sync_core`, persist the
/// ledger (re-reading so a config edit / delete mid-sync isn't clobbered).
async fn sync_once(app: &AppHandle) -> Result<bool, String> {
    let cfg = read_sync_config(app);
    let Some((base, token)) = cfg.endpoint() else {
        return Ok(false);
    };
    let dir = drafts_dir(app)?;
    let (changed, synced, pushed_deletes) = sync_core(
        http_client(),
        &base,
        token,
        &dir,
        cfg.synced.clone(),
        &cfg.tombstones,
    )
    .await?;

    let mut latest = read_sync_config(app);
    latest.synced = synced;
    for id in pushed_deletes {
        latest.tombstones.remove(&id);
    }
    write_sync_config(app, &latest)?;
    Ok(changed)
}

/// The engine, decoupled from `AppHandle` so it can be driven against a tempdir +
/// mock HTTP server in tests. Pulls (remote -> local), then pushes (local ->
/// remote) + DELETEs tombstones. Returns `(changed_on_disk, new_synced_ledger,
/// pushed_delete_ids)`; the caller persists the ledger.
async fn sync_core(
    client: &reqwest::Client,
    base: &str,
    token: &str,
    dir: &Path,
    mut synced: HashMap<String, i64>,
    tombstones: &HashMap<String, i64>,
) -> Result<(bool, HashMap<String, i64>, Vec<String>), String> {
    let mut changed = false;
    let mut local: HashMap<String, Draft> = read_all_drafts_in(dir)?
        .into_iter()
        .map(|d| (d.id.clone(), d))
        .collect();

    // --- Pull: remote -> local ---
    let list: DraftsList = client
        .get(format!("{base}/drafts"))
        .bearer_auth(token)
        .send()
        .await
        .map_err(msg)?
        .error_for_status()
        .map_err(msg)?
        .json()
        .await
        .map_err(msg)?;

    for entry in list.drafts {
        // A draft this device has just deleted is still listed by the worker
        // until our own DELETE goes out later in this pass. Pulling it back
        // first would resurrect it in the sidebar for one sync interval, and
        // the pass after that would delete it again.
        if tombstones.contains_key(&entry.id) {
            continue;
        }
        if entry.deleted {
            if let Some(l) = local.get(&entry.id) {
                // A remote deletion has no authority over a draft that no
                // longer syncs. Opting a file out records a tombstone, the
                // worker echoes it back as deleted, and applying that here
                // would remove the local draft two passes later.
                if syncs_to_cloud(l) && delete_wins(l.updated_at, entry.updated_at) {
                    let _ = fs::remove_file(draft_path(dir, &entry.id));
                    local.remove(&entry.id);
                    changed = true;
                }
            }
            synced.insert(entry.id.clone(), entry.updated_at);
            continue;
        }
        let need = match local.get(&entry.id) {
            None => true,
            Some(l) => remote_supersedes(entry.updated_at, l.updated_at),
        };
        if need {
            let resp = client
                .get(format!("{base}/drafts/{}", entry.id))
                .bearer_auth(token)
                .send()
                .await
                .map_err(msg)?;
            if resp.status().is_success() {
                let mut remote: Draft = resp.json().await.map_err(msg)?;
                // Never overwrite the device-local file path; keep the local one.
                remote.file_path = local.get(&entry.id).and_then(|l| l.file_path.clone());
                // write_draft_in records the file's new mtime in the stored
                // entry, so pulling a newer copy does not look like an outside
                // edit the next time this draft is saved.
                remote.file_mtime = write_draft_in(dir, &remote)?;
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
        if !syncs_to_cloud(d) {
            continue; // file opened from disk, not opted in — stays local
        }
        if needs_push(d.updated_at, synced.get(id).copied()) {
            let mut up = d.clone();
            up.file_path = None; // device-local; never leaves the machine
            up.file_mtime = None; // ditto — it describes this machine's copy
            let body = serde_json::to_string(&up).map_err(msg)?;
            let resp = client
                .put(format!("{base}/drafts/{id}"))
                .bearer_auth(token)
                .header("content-type", "application/json")
                .body(body)
                .send()
                .await
                .map_err(msg)?;
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
            .bearer_auth(token)
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false);
        if ok {
            synced.insert(id.clone(), *at);
            pushed_deletes.push(id.clone());
        }
    }

    Ok((changed, synced, pushed_deletes))
}

/// `sync:status` for the status bar: `{ state, ...extra }`. Best effort; a
/// webview that is not listening yet is not an error.
fn emit_status(app: &AppHandle, state: &str, extra: serde_json::Value) {
    let mut payload = serde_json::json!({ "state": state });
    if let (Some(map), Some(more)) = (payload.as_object_mut(), extra.as_object()) {
        map.extend(more.clone());
    }
    let _ = app.emit("sync:status", payload);
}

/// Run a sync pass in the background. Serialized by `SyncState` so passes never
/// overlap; emits `sync:status` (syncing/idle/error) and `sync:changed` when
/// something landed locally.
#[tauri::command]
async fn sync_now(app: AppHandle) -> Result<(), String> {
    // Silent no-op when sync isn't set up, so the launch-time call emits no status
    // for users who never configured it. Configured (URL + token) == syncing.
    if read_sync_config(&app).endpoint().is_none() {
        return Ok(());
    }
    let state = app.state::<SyncState>();
    if state.running.swap(true, Ordering::SeqCst) {
        return Ok(()); // a sync is already in flight
    }
    emit_status(&app, "syncing", serde_json::json!({}));
    let result = sync_once(&app).await;
    app.state::<SyncState>()
        .running
        .store(false, Ordering::SeqCst);
    match result {
        Ok(changed) => {
            if changed {
                let _ = app.emit("sync:changed", ());
            }
            emit_status(&app, "idle", serde_json::json!({ "at": now_ms() }));
            Ok(())
        }
        Err(e) => {
            emit_status(&app, "error", serde_json::json!({ "message": e.clone() }));
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
    allow_drafts(&app, &drafts);
    Ok(drafts)
}

/// Ids of drafts present in the sync ledger (backed up to the cloud), for the
/// sidebar "synced" cloud marker. Empty when sync is unconfigured.
#[tauri::command]
fn synced_ids(app: AppHandle) -> Vec<String> {
    read_sync_config(&app).synced.into_keys().collect()
}

// --- Read-only sharing (C4) -------------------------------------------------
//
// The worker's D1 is the source of truth for which draft is shared at which URL.
// The app keeps only a disposable cache (shares.json) so the context menu +
// sidebar link marker are instant and correct cross-device.

/// One shared draft, as cached and returned to the UI. Holds only a public URL.
#[derive(Serialize, Deserialize, Clone)]
struct ShareInfo {
    #[serde(rename = "shareId")]
    share_id: String,
    url: String,
}

type ShareCache = HashMap<String, ShareInfo>; // draft_id -> ShareInfo

fn shares_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_dir(app)?.join("shares.json"))
}

fn read_shares(app: &AppHandle) -> ShareCache {
    read_json(shares_file(app))
}

fn write_shares(app: &AppHandle, cache: &ShareCache) -> Result<(), String> {
    write_json(&shares_file(app)?, cache)
}

/// One client for the whole process: reqwest pools connections per client, so
/// a fresh one per call paid a new TLS handshake on every sync tick.
fn http_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .expect("reqwest client with default TLS")
    })
}

/// Fetch the live share registry from the worker (`GET /shares`) into a cache map.
async fn fetch_shares(
    client: &reqwest::Client,
    base: &str,
    token: &str,
) -> Result<ShareCache, String> {
    #[derive(Deserialize)]
    struct Row {
        #[serde(rename = "draftId")]
        draft_id: String,
        #[serde(rename = "shareId")]
        share_id: String,
        url: String,
    }
    #[derive(Deserialize)]
    struct List {
        #[serde(default)]
        shares: Vec<Row>,
    }
    let list: List = client
        .get(format!("{base}/shares"))
        .bearer_auth(token)
        .send()
        .await
        .map_err(msg)?
        .error_for_status()
        .map_err(msg)?
        .json()
        .await
        .map_err(msg)?;
    Ok(list
        .shares
        .into_iter()
        .map(|r| {
            (
                r.draft_id,
                ShareInfo {
                    share_id: r.share_id,
                    url: r.url,
                },
            )
        })
        .collect())
}

/// Create (or replace) a draft's public share. Snapshots title + content to the
/// worker's D1 and returns the URL; updates the local cache.
#[tauri::command]
async fn create_share(app: AppHandle, id: String) -> Result<ShareInfo, String> {
    let cfg = read_sync_config(&app);
    let Some((base, token)) = cfg.endpoint() else {
        return Err("cloud not configured".into());
    };
    let draft = read_draft(&app, &id).ok_or_else(|| "draft not found".to_string())?;

    #[derive(Serialize)]
    struct Req<'a> {
        #[serde(rename = "draftId")]
        draft_id: &'a str,
        title: &'a str,
        content: &'a str,
        // When the note was last edited, so the share page can show an "Updated" line.
        #[serde(rename = "updatedAt")]
        updated_at: i64,
    }
    #[derive(Deserialize)]
    struct Resp {
        #[serde(rename = "shareId")]
        share_id: String,
        url: String,
    }
    let resp = http_client()
        .post(format!("{base}/share"))
        .bearer_auth(token)
        .json(&Req {
            draft_id: &id,
            title: &draft.title,
            content: &draft.content,
            updated_at: draft.updated_at,
        })
        .send()
        .await
        .map_err(msg)?;
    if !resp.status().is_success() {
        return Err(format!("share failed ({})", resp.status().as_u16()));
    }
    let r: Resp = resp.json().await.map_err(msg)?;
    let info = ShareInfo {
        share_id: r.share_id,
        url: r.url,
    };

    let mut cache = read_shares(&app);
    cache.insert(id, info.clone());
    write_shares(&app, &cache)?;
    Ok(info)
}

/// Revoke a draft's share (hard delete — the `/s/:id` link 404s immediately).
#[tauri::command]
async fn revoke_share(app: AppHandle, id: String) -> Result<(), String> {
    let cfg = read_sync_config(&app);
    let Some((base, token)) = cfg.endpoint() else {
        return Err("cloud not configured".into());
    };
    let client = http_client();
    let mut cache = read_shares(&app);

    // Resolve the share id from the cache, else ask the worker.
    let share_id = match cache.get(&id) {
        Some(info) => info.share_id.clone(),
        None => match fetch_shares(client, &base, token).await?.get(&id) {
            Some(info) => info.share_id.clone(),
            None => return Ok(()), // nothing to revoke
        },
    };
    let resp = client
        .delete(format!("{base}/share/{share_id}"))
        .bearer_auth(token)
        .send()
        .await
        .map_err(msg)?;
    // 2xx = revoked; 404 = already gone. Anything else means the share may still
    // be live, so keep the cache entry and surface the failure to the UI.
    if !resp.status().is_success() && resp.status().as_u16() != 404 {
        return Err(format!("revoke failed ({})", resp.status().as_u16()));
    }
    cache.remove(&id);
    write_shares(&app, &cache)?;
    Ok(())
}

/// Refresh the local share cache from the worker (source of truth). Returns the
/// full map for the UI. No-op (empty) when unconfigured.
#[tauri::command]
async fn refresh_shares(app: AppHandle) -> Result<ShareCache, String> {
    let cfg = read_sync_config(&app);
    let Some((base, token)) = cfg.endpoint() else {
        return Ok(ShareCache::new());
    };
    let map = fetch_shares(http_client(), &base, token).await?;
    write_shares(&app, &map)?;
    Ok(map)
}

// --- Open with / file associations -----------------------------------------
//
// When the OS hands us a file (double-click a `.txt`, "Open With → Jotter", or a
// path on the command line), the request can arrive *before* the webview is ready
// to listen — especially on a cold launch, where macOS delivers the file through
// `RunEvent::Opened` during startup. So we buffer paths here and let the frontend
// drain them via `take_opened_files` once it boots. While the app is already
// running, `deliver_opened_paths` emits `open-files` straight to the webview.

/// Launch-time open queue. `ready` flips true the first time the frontend drains
/// it; from then on later opens are emitted live instead of buffered.
#[derive(Default)]
struct OpenedFiles {
    ready: bool,
    paths: Vec<String>,
}

/// Route OS-supplied paths to the webview: filter to real files, then either emit
/// (webview ready) or buffer (cold launch, frontend not listening yet).
fn deliver_opened_paths(app: &AppHandle, paths: Vec<String>) {
    let files: Vec<String> = paths
        .into_iter()
        .filter(|p| Path::new(p).is_file())
        .map(|p| canonical(&p))
        .collect();
    if files.is_empty() {
        return;
    }
    for f in &files {
        allow_path(app, f);
    }
    let state = app.state::<Mutex<OpenedFiles>>();
    let mut opened = state.lock().unwrap();
    if opened.ready {
        let _ = app.emit("open-files", &files);
    } else {
        opened.paths.extend(files);
    }
}

/// Drain the launch-time open queue and mark the app "ready". The frontend calls
/// this once on boot; subsequent opens arrive via the `open-files` event.
#[tauri::command]
fn take_opened_files(app: AppHandle) -> Vec<String> {
    let state = app.state::<Mutex<OpenedFiles>>();
    let mut opened = state.lock().unwrap();
    opened.ready = true;
    std::mem::take(&mut opened.paths)
}

/// Pull candidate file paths out of a raw argv: skip the binary (arg 0) and any
/// flags. `deliver_opened_paths` does the real-file filtering. Shared by the
/// launch-time CLI scan and the single-instance forward, so both behave the same.
#[cfg(any(not(target_os = "macos"), feature = "e2e"))]
fn file_paths_from_args<I: IntoIterator<Item = String>>(args: I) -> Vec<String> {
    args.into_iter()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .collect()
}

/// File paths on this process's command line. Used for Windows/Linux
/// launch-with-file (where `RunEvent::Opened` doesn't fire).
#[cfg(any(not(target_os = "macos"), feature = "e2e"))]
fn cli_file_args() -> Vec<String> {
    file_paths_from_args(std::env::args())
}

/// Lower the macOS traffic lights so they sit on the tab bar's centre line.
///
/// AppKit centres the three buttons inside a title-bar container view that is
/// anchored to the top of the window, so giving that view the tab bar's height
/// puts the buttons on the same centre line as the tabs. There is no Tauri or
/// AppKit API for this — the container has to be reached through the close
/// button's view hierarchy, which is why every step here is best-effort: if a
/// future macOS reshapes that hierarchy, the lights simply stay where the system
/// put them instead of the app breaking.
///
/// `bar_height` must match `--titlebar-h` in styles.css.
#[cfg(target_os = "macos")]
fn position_traffic_lights(window: &tauri::WebviewWindow, bar_height: f64) {
    use objc2_app_kit::{NSWindow, NSWindowButton};

    let Ok(ptr) = window.ns_window() else { return };
    if ptr.is_null() {
        return;
    }

    // Safety: Tauri hands back the NSWindow for this window, and we only touch
    // it on the main thread (callers are the setup hook and the event loop).
    unsafe {
        let ns_window = &*(ptr as *const NSWindow);
        let Some(close) = ns_window.standardWindowButton(NSWindowButton::CloseButton) else {
            return;
        };
        // close -> the buttons' container -> the title-bar container view.
        let Some(container) = close.superview().and_then(|v| v.superview()) else {
            return;
        };

        let window_height = ns_window.frame().size.height;
        let mut frame = container.frame();
        frame.size.height = bar_height;
        frame.origin.y = window_height - bar_height;
        container.setFrame(frame);
    }
}

#[cfg(not(target_os = "macos"))]
fn position_traffic_lights(_window: &tauri::WebviewWindow, _bar_height: f64) {}

/// Height of the app's title-bar row. Keep in sync with `--titlebar-h` in styles.css.
const TITLEBAR_H: f64 = 40.0;

/// Menu ids the webview handles (the `listen("menu", …)` switch in main.js).
/// The event handler forwards exactly these; a test checks main.js knows them.
const MENU_IDS: &[&str] = &[
    "about",
    "new",
    "open",
    "switcher",
    "save",
    "save_as",
    "close_tab",
    "reopen_tab",
    "find",
    "find_next",
    "find_prev",
    "toggle_sidebar",
    "toggle_preview",
    "focus_mode",
    "settings",
    "prev_tab",
    "next_tab",
];

/// A menu item that the webview handles. `id` must be in MENU_IDS.
fn item(
    app: &AppHandle,
    id: &str,
    label: &str,
    accel: Option<&str>,
) -> tauri::Result<tauri::menu::MenuItem<tauri::Wry>> {
    debug_assert!(MENU_IDS.contains(&id), "menu id {id} is not in MENU_IDS");
    let mut b = MenuItemBuilder::with_id(id, label);
    if let Some(a) = accel {
        b = b.accelerator(a);
    }
    b.build(app)
}

fn build_menu(app: &AppHandle) -> tauri::Result<()> {
    let about = item(app, "about", "About Jotter", None)?;
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

    let new = item(app, "new", "New Draft", Some("CmdOrCtrl+N"))?;
    let new_tab = item(app, "new", "New Tab", Some("CmdOrCtrl+T"))?;
    let open = item(app, "open", "Open…", Some("CmdOrCtrl+O"))?;
    let quick_open = item(app, "switcher", "Quick Open…", Some("CmdOrCtrl+P"))?;
    let save = item(app, "save", "Save…", Some("CmdOrCtrl+S"))?;
    let save_as = item(app, "save_as", "Save As…", Some("Shift+CmdOrCtrl+S"))?;
    let close_tab = item(app, "close_tab", "Close Tab", Some("CmdOrCtrl+W"))?;
    let reopen_tab = item(
        app,
        "reopen_tab",
        "Reopen Closed Tab",
        Some("Shift+CmdOrCtrl+T"),
    )?;

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

    let find = item(app, "find", "Find…", Some("CmdOrCtrl+F"))?;
    let find_next = item(app, "find_next", "Find Next", Some("CmdOrCtrl+G"))?;
    let find_prev = item(app, "find_prev", "Find Previous", Some("Shift+CmdOrCtrl+G"))?;
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

    let toggle_sidebar = item(
        app,
        "toggle_sidebar",
        "Toggle Drafts Sidebar",
        Some("CmdOrCtrl+B"),
    )?;
    let toggle_preview = item(
        app,
        "toggle_preview",
        "Toggle Markdown Preview",
        Some("Shift+CmdOrCtrl+P"),
    )?;
    // Focus Mode owns the fullscreen key, and goes fullscreen itself — so the
    // Window menu below deliberately drops the stock "Enter Full Screen" item
    // rather than let two items claim the same accelerator.
    let focus_mode = item(
        app,
        "focus_mode",
        "Focus Mode",
        Some(if cfg!(target_os = "macos") {
            "Control+Command+F"
        } else {
            "F11"
        }),
    )?;
    let settings = item(app, "settings", "Settings…", Some("CmdOrCtrl+,"))?;
    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&toggle_sidebar)
        .item(&toggle_preview)
        .separator()
        .item(&focus_mode)
        .separator()
        .item(&settings)
        .build()?;

    // No accelerators here: Tab-based menu accelerators (Control+Tab) are
    // unreliable on macOS — AppKit swallows the key before the menu acts, so the
    // shortcut is handled in the webview (see the keydown handler in main.js).
    // Menu items stay for discoverability / click access.
    let prev_tab = item(app, "prev_tab", "Show Previous Tab", None)?;
    let next_tab = item(app, "next_tab", "Show Next Tab", None)?;
    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .separator()
        .item(&prev_tab)
        .item(&next_tab)
        .build()?;

    let menu = MenuBuilder::new(app)
        .items(&[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu])
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
    let Some(win) = main_window(app) else {
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
    let saved: Option<WindowGeom> = read_json(geom_file(app));
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
        if let Ok(path) = geom_file(win.app_handle()) {
            let _ = write_json(&path, &geom);
        }
    }
}

// --- Quitting ---------------------------------------------------------------
//
// The last keystrokes, a delete still inside its undo window, and a final sync
// all live in the webview, and `beforeunload` cannot wait for them: the page is
// already being torn down, so its `invoke`s race the process. So the host holds
// the quit instead — it asks the page to finish, and the page says when it has.

/// Where a quit has got to: nobody has asked yet, the page has been asked, or
/// the last writes are done (either the page said so, or it was waited out).
const QUIT_IDLE: u8 = 0;
const QUIT_ASKED: u8 = 1;
const QUIT_DONE: u8 = 2;

#[derive(Default)]
struct Quitting(std::sync::atomic::AtomicU8);

/// How long the host waits for the page before quitting anyway. Long enough for
/// a save and a sync on a slow link, short enough that a page that never answers
/// does not look like a hang.
const QUIT_GRACE: std::time::Duration = std::time::Duration::from_secs(5);

/// Ask the page to finish its last writes. Returns true while the quit should be
/// held back, false once there is nothing left to wait for.
fn hold_for_last_writes(app: &AppHandle) -> bool {
    let state = app.state::<Quitting>();
    match state
        .0
        .compare_exchange(QUIT_IDLE, QUIT_ASKED, Ordering::SeqCst, Ordering::SeqCst)
    {
        // Already asked (a window close and the exit behind it are one quit),
        // or already finished.
        Err(seen) => seen != QUIT_DONE,
        Ok(_) => {
            let _ = app.emit("before-quit", ());
            let handle = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(QUIT_GRACE);
                let state = handle.state::<Quitting>();
                if state.0.swap(QUIT_DONE, Ordering::SeqCst) != QUIT_DONE {
                    handle.exit(0);
                }
            });
            true
        }
    }
}

/// The page has written everything it had. Called from its `before-quit`
/// handler; the quit waits on this, so the page must reach it on every path out
/// of that handler, error or not.
#[tauri::command]
fn confirm_quit(app: AppHandle) {
    if app.state::<Quitting>().0.swap(QUIT_DONE, Ordering::SeqCst) == QUIT_DONE {
        return; // the grace period won; the app is already on its way out
    }
    if let Some(win) = main_window(&app) {
        save_window(&win);
    }
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // `mut` is used only on Windows/Linux (single-instance plugin); on macOS the
    // reassignment is cfg'd out, so silence the otherwise-spurious warning there.
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();

    // Single-instance must be the FIRST plugin registered — it intercepts a second
    // launch before anything else spins up. Windows/Linux only: a second launch
    // (e.g. double-clicking a file while Jotter is open) is routed into the running
    // window instead of starting a new process, and its file arg is delivered
    // through the same path as a cold-launch open. macOS handles this natively via
    // RunEvent::Opened, so it doesn't need — or want — single-instance here.
    #[cfg(any(windows, target_os = "linux"))]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(win) = main_window(app) {
                let _ = win.set_focus();
            }
            deliver_opened_paths(app, file_paths_from_args(args));
        }));
    }

    // The WebDriver server for the E2E suite. Behind a Cargo feature that
    // release builds never pass: it exposes automation over HTTP on
    // 127.0.0.1:4445 and must not exist in a shipped binary.
    #[cfg(feature = "e2e")]
    {
        builder = builder.plugin(tauri_plugin_wdio_webdriver::init());
    }

    builder
        .manage(SyncState {
            running: AtomicBool::new(false),
        })
        .manage(Mutex::new(OpenedFiles::default()))
        .manage(Allowed::default())
        .manage(Quitting::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
            build_menu(app.handle())?;
            restore_window(app.handle());
            if let Some(win) = main_window(app) {
                position_traffic_lights(&win, TITLEBAR_H);
            }
            // Windows/Linux launch-with-file: the path is a CLI arg, not an
            // `Opened` event. Buffer it so the frontend picks it up on boot.
            // The E2E build takes CLI args on macOS too: WebDriver cannot
            // drive Finder, so a command-line path is how a test opens a file.
            #[cfg(any(not(target_os = "macos"), feature = "e2e"))]
            {
                let args = cli_file_args();
                if !args.is_empty() {
                    deliver_opened_paths(app.handle(), args);
                }
            }
            Ok(())
        })
        .on_menu_event(|app, event| {
            let id = event.id().0.as_str();
            if MENU_IDS.contains(&id) {
                if let Some(window) = main_window(app) {
                    let _ = window.emit("menu", id);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            init_store,
            is_e2e,
            save_entry,
            save_draft,
            delete_draft,
            read_text_file,
            canonical_path,
            write_text_file,
            set_sync_config,
            get_sync_config,
            get_sync_token,
            sync_test_connection,
            sync_now,
            list_drafts,
            synced_ids,
            get_drafts_dir,
            set_drafts_dir,
            open_drafts_dir,
            write_conflict_copy,
            set_cloud,
            save_meta,
            create_share,
            revoke_share,
            refresh_shares,
            take_opened_files,
            pick_file,
            pick_save_path,
            pick_folder,
            confirm_quit
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| match event {
            // Persist the window size when it closes or the app quits, so the next
            // launch restores it (see restore_window / save_window).
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::CloseRequested { ref api, .. },
                ..
            } => {
                if let Some(win) = app_handle.get_webview_window(&label) {
                    save_window(&win);
                }
                // Closing the window destroys the webview, so the page has to
                // finish before the close goes through, not after it.
                if hold_for_last_writes(app_handle) {
                    api.prevent_close();
                }
            }
            // The traffic lights' container is anchored to the window's top edge by
            // an absolute y, so every resize needs it recomputed.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::Resized(_),
                ..
            } => {
                if let Some(win) = app_handle.get_webview_window(&label) {
                    position_traffic_lights(&win, TITLEBAR_H);
                }
            }
            // A file dropped on the window was chosen by the user as plainly as
            // one picked in a dialog; the page reads the same paths from its own
            // drag-drop event.
            tauri::RunEvent::WindowEvent {
                event: tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { ref paths, .. }),
                ..
            } => {
                for p in paths {
                    allow_path(app_handle, &path_str(p));
                }
            }
            tauri::RunEvent::ExitRequested { ref api, .. } => {
                if let Some(win) = main_window(app_handle) {
                    save_window(&win);
                }
                if hold_for_last_writes(app_handle) {
                    api.prevent_exit();
                }
            }
            // macOS delivers "open this file" here (double-click / "Open With"),
            // both at launch and while running. The urls are `file://` — convert
            // to plain paths the webview can hand to `read_text_file`.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Opened { urls } => {
                let paths: Vec<String> = urls
                    .iter()
                    .filter_map(|u| u.to_file_path().ok())
                    .map(|p| path_str(&p))
                    .collect();
                deliver_opened_paths(app_handle, paths);
            }
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_is_readable_only_after_the_user_picks_it() {
        let set = Allowed::default();
        assert!(check_in(&set, "/Users/someone/.ssh/id_rsa").is_err());
        allow_in(&set, "/Users/someone/notes.txt");
        assert!(check_in(&set, "/Users/someone/notes.txt").is_ok());
        assert!(check_in(&set, "/Users/someone/.ssh/id_rsa").is_err());
    }

    #[test]
    fn a_picked_path_matches_however_the_page_spells_it_back() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("notes.txt");
        fs::write(&file, "hi").unwrap();

        let set = Allowed::default();
        allow_in(&set, &path_str(&file));
        // Same file by a route through its own directory: what an "Open With"
        // or a drop can hand back after the dialog spelled it differently.
        let round_about = dir.path().join(".").join("notes.txt");
        assert!(check_in(&set, &path_str(&round_about)).is_ok());
    }

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

    /// Same cases as `isEmpty` in lib/text.test.js, from one file, so the
    /// JS and Rust rules cannot drift apart without a suite going red.
    #[test]
    fn orphan_rule_matches_js_is_empty() {
        #[derive(Deserialize)]
        struct Case {
            why: String,
            content: String,
            file_path: Option<String>,
            title: String,
            empty: bool,
        }
        let cases: Vec<Case> =
            serde_json::from_str(include_str!("../../src/lib/empty-drafts.json")).unwrap();
        assert!(cases.len() >= 6);
        for c in cases {
            let d = Draft {
                title: c.title,
                ..draft(&c.content, c.file_path.as_deref())
            };
            assert_eq!(is_orphan(&d), c.empty, "{}", c.why);
        }
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
        let out = apply_config_update(
            cfg_with_token("secret"),
            true,
            "https://new.example".into(),
            None,
        );
        assert_eq!(out.token, "secret"); // token untouched
        assert!(out.enabled);
        assert_eq!(out.url, "https://new.example");
    }

    #[test]
    fn update_preserves_token_when_empty_string() {
        let out = apply_config_update(
            cfg_with_token("secret"),
            false,
            "https://x".into(),
            Some(String::new()),
        );
        assert_eq!(out.token, "secret");
    }

    #[test]
    fn update_replaces_token_when_supplied() {
        let out = apply_config_update(
            cfg_with_token("old"),
            false,
            "https://x".into(),
            Some("new".into()),
        );
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
        let out = apply_config_update(
            SyncConfig::default(),
            false,
            "  https://x.example///  ".into(),
            None,
        );
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
    fn writing_a_file_backed_draft_records_the_files_mtime() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("note.txt");
        let path = path_str(&file);
        let mut d = draft("hello", Some(&path));
        d.id = "note".into();
        d.file_mtime = Some(1); // deliberately wrong

        write_draft_in(dir.path(), &d).unwrap();

        let stored: Draft =
            serde_json::from_str(&fs::read_to_string(draft_path(dir.path(), "note")).unwrap())
                .unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "hello");
        // The entry describes the file as it now is, not as the caller thought.
        assert_eq!(stored.file_mtime, mtime_ms(file.to_str().unwrap()));
        assert!(!is_conflict(
            stored.file_mtime,
            mtime_ms(file.to_str().unwrap())
        ));
    }

    #[test]
    fn a_named_draft_is_not_an_orphan_even_when_empty() {
        let mut d = Draft::default();
        assert!(is_orphan(&d)); // nothing at all

        d.title = "Shopping".into();
        assert!(!is_orphan(&d)); // renamed, then cleared — still deliberate

        d.title = "   ".into();
        assert!(is_orphan(&d)); // whitespace is not a name

        d.title = String::new();
        d.content = "hi".into();
        assert!(!is_orphan(&d));

        d.content = String::new();
        d.file_path = Some("/tmp/a.txt".into());
        assert!(!is_orphan(&d));
    }

    #[test]
    fn verbatim_prefix_is_stripped_and_other_paths_pass_through() {
        assert_eq!(
            strip_verbatim(r"\\?\C:\Users\me\a.txt".into()),
            r"C:\Users\me\a.txt"
        );
        assert_eq!(
            strip_verbatim(r"\\?\UNC\srv\share\a.txt".into()),
            r"\\srv\share\a.txt"
        );
        assert_eq!(strip_verbatim("/Users/me/a.txt".into()), "/Users/me/a.txt");
        assert_eq!(strip_verbatim(r"C:\plain\a.txt".into()), r"C:\plain\a.txt");
    }

    #[test]
    fn canonical_resolves_dots_and_keeps_the_name_of_a_file_not_yet_written() {
        let dir = TempDir::new().unwrap();
        let real = dir.path().join("real");
        fs::create_dir(&real).unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();

        // `..` in the middle, file does not exist: directory resolved, name kept.
        let dotted = dir
            .path()
            .join("real")
            .join("..")
            .join("real")
            .join("new.txt");
        assert_eq!(
            canonical(dotted.to_str().unwrap()),
            root.join("real").join("new.txt").to_string_lossy()
        );

        // Existing file: fully resolved.
        fs::write(real.join("a.txt"), "x").unwrap();
        assert_eq!(
            canonical(dotted.with_file_name("a.txt").to_str().unwrap()),
            root.join("real").join("a.txt").to_string_lossy()
        );

        // Nothing resolvable at all: unchanged.
        assert_eq!(
            canonical("/no/such/dir/at/all.txt"),
            "/no/such/dir/at/all.txt"
        );
    }

    #[cfg(unix)]
    #[test]
    fn canonical_follows_a_symlinked_folder_even_for_a_new_file() {
        let dir = TempDir::new().unwrap();
        let real = dir.path().join("real");
        fs::create_dir(&real).unwrap();
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();

        let via_link = link.join("new.txt");
        assert_eq!(
            canonical(via_link.to_str().unwrap()),
            root.join("real").join("new.txt").to_string_lossy()
        );
    }

    #[test]
    fn update_entry_changes_only_the_store_copy() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("note.txt");
        fs::write(&file, "newer on disk").unwrap();
        let mut d = draft("older in store", Some(file.to_str().unwrap()));
        d.id = "n".into();
        write_entry_in(dir.path(), &d).unwrap();

        let out = update_entry_in(dir.path(), "n", |d| {
            d.title = "Named".into();
            d.pinned = true;
            d.updated_at = 999;
        })
        .unwrap();
        assert_eq!(out.title, "Named");
        let stored: Draft =
            serde_json::from_str(&fs::read_to_string(draft_path(dir.path(), "n")).unwrap())
                .unwrap();
        assert!(stored.pinned);
        assert_eq!(stored.updated_at, 999);
        assert_eq!(stored.content, "older in store"); // content untouched
        assert_eq!(fs::read_to_string(&file).unwrap(), "newer on disk"); // file untouched
        assert!(update_entry_in(dir.path(), "missing", |_| {}).is_err());
    }

    #[test]
    fn set_cloud_flips_the_entry_and_leaves_the_text_file_alone() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("note.txt");
        fs::write(&file, "on disk, newer than the store").unwrap();
        let mut d = draft("stale store copy", Some(file.to_str().unwrap()));
        d.id = "n".into();
        write_entry_in(dir.path(), &d).unwrap();

        let on = set_cloud_in(dir.path(), "n", true).unwrap();
        assert!(on.cloud);
        let stored: Draft =
            serde_json::from_str(&fs::read_to_string(draft_path(dir.path(), "n")).unwrap())
                .unwrap();
        assert!(stored.cloud);
        // The whole point of an entry-only write.
        assert_eq!(
            fs::read_to_string(&file).unwrap(),
            "on disk, newer than the store"
        );

        assert!(!set_cloud_in(dir.path(), "n", false).unwrap().cloud);
        assert!(set_cloud_in(dir.path(), "missing", true).is_err());
    }

    #[test]
    fn menu_ids_are_unique_and_main_js_handles_every_one() {
        let mut seen = std::collections::HashSet::new();
        for id in MENU_IDS {
            assert!(seen.insert(id), "duplicate menu id {id}");
        }
        // The webview's switch is the other half of this contract; read it so
        // a menu id added here without a JS case fails at test time, not when
        // a user clicks a menu item that does nothing.
        let main_js = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../src/main.js"))
            .expect("src/main.js next to src-tauri");
        for id in MENU_IDS {
            let case = format!("case \"{id}\":");
            assert!(
                main_js.contains(&case),
                "main.js has no `{case}` for menu id {id}"
            );
        }
    }

    /// The Shortcuts help list in main.js is typed by hand. Read every
    /// accelerator this file gives a menu item (`Some("CmdOrCtrl+...")`) and
    /// check the list shows it, so a changed or added shortcut cannot leave
    /// the help page stale.
    #[test]
    fn every_menu_accelerator_is_in_the_shortcuts_list() {
        let main_js = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../src/main.js"))
            .expect("src/main.js next to src-tauri");
        let list_start = main_js
            .find("const SHORTCUTS = [")
            .expect("SHORTCUTS in main.js");
        let list = &main_js[list_start..];
        let list = &list[..list.find("\n];").expect("end of SHORTCUTS")];

        let src = include_str!("lib.rs");
        let mut found = 0;
        for piece in src.split("Some(\"").skip(1) {
            let accel = &piece[..piece.find('"').unwrap()];
            let real = accel
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == ',');
            if !accel.contains("CmdOrCtrl") || !real {
                continue; // prose, like the one in this test's own doc comment
            }
            found += 1;
            let symbols = accel_symbols(accel);
            assert!(
                list.contains(&symbols),
                "menu accelerator {accel} ({symbols}) is not in SHORTCUTS"
            );
        }
        assert!(found >= 10, "expected the menu accelerators, found {found}");
    }

    /// `Shift+CmdOrCtrl+S` -> `⇧⌘S`, the way SHORTCUTS writes them.
    fn accel_symbols(accel: &str) -> String {
        let mut out = String::new();
        for part in accel.split('+') {
            out.push_str(match part {
                "Shift" => "⇧",
                "Ctrl" | "Control" => "⌃",
                "Alt" | "Option" => "⌥",
                "CmdOrCtrl" | "Cmd" | "Super" => "⌘",
                key => key,
            });
        }
        out
    }

    #[test]
    fn conflict_copy_sits_beside_the_original() {
        assert_eq!(
            conflict_copy_path(Path::new("/a/b/notes.md")),
            PathBuf::from("/a/b/notes (conflicted copy).md")
        );
        // No extension, and a name that is all extension.
        assert_eq!(
            conflict_copy_path(Path::new("/a/b/README")),
            PathBuf::from("/a/b/README (conflicted copy)")
        );
        assert_eq!(
            conflict_copy_path(Path::new("/a/b/notes.tar.gz")),
            PathBuf::from("/a/b/notes.tar (conflicted copy).gz")
        );
    }

    #[test]
    fn conflict_only_when_two_known_times_differ() {
        assert!(is_conflict(Some(1), Some(2)));
        assert!(!is_conflict(Some(1), Some(1)));
        // "keep mine": the frontend drops the recorded time to force a write.
        assert!(!is_conflict(None, Some(2)));
        // The file is gone or unreadable — refusing would strand the text.
        assert!(!is_conflict(Some(1), None));
        assert!(!is_conflict(None, None));
    }

    #[test]
    fn write_atomic_replaces_contents_and_leaves_no_temp_file() {
        let dir = TempDir::new().unwrap();
        let target = dir.path().join("note.txt");

        write_atomic(&target, b"first").unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "first");

        write_atomic(&target, b"second").unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "second");

        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n != "note.txt")
            .collect();
        assert!(leftovers.is_empty(), "left behind: {leftovers:?}");
    }

    #[cfg(unix)]
    #[test]
    fn write_atomic_keeps_the_targets_permission_bits() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new().unwrap();
        let target = dir.path().join("private.txt");
        fs::write(&target, "first").unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();

        write_atomic(&target, b"second").unwrap();

        let mode = fs::metadata(&target).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "rename must not reset the file's mode");
        assert_eq!(fs::read_to_string(&target).unwrap(), "second");
    }

    #[test]
    fn write_atomic_reports_a_missing_directory_rather_than_panicking() {
        let dir = TempDir::new().unwrap();
        let target = dir.path().join("no-such-dir").join("note.txt");
        assert!(write_atomic(&target, b"x").is_err());
    }

    #[test]
    fn mtime_is_none_for_a_path_that_is_not_there() {
        let dir = TempDir::new().unwrap();
        let missing = dir.path().join("nope.txt");
        assert_eq!(mtime_ms(missing.to_str().unwrap()), None);
    }

    #[test]
    fn mtime_is_read_back_after_a_write() {
        let dir = TempDir::new().unwrap();
        let target = dir.path().join("note.txt");
        write_atomic(&target, b"hello").unwrap();
        assert!(mtime_ms(target.to_str().unwrap()).is_some());
    }

    #[test]
    fn only_in_app_or_opted_in_files_sync() {
        assert!(syncs_to_cloud(&draft("note", None))); // in-app note -> always syncs
        assert!(!syncs_to_cloud(&draft("note", Some("/tmp/a.txt")))); // opened file -> local
        let mut opted_in = draft("note", Some("/tmp/a.txt"));
        opted_in.cloud = true;
        assert!(syncs_to_cloud(&opted_in)); // explicit opt-in -> syncs
    }

    #[test]
    fn only_https_or_localhost_may_receive_the_token() {
        assert!(is_safe_worker_url("https://jotter.example.workers.dev"));
        assert!(is_safe_worker_url("  https://x.example/  "));
        assert!(is_safe_worker_url("")); // not configured yet
        assert!(is_safe_worker_url("http://localhost:8787"));
        assert!(is_safe_worker_url("http://127.0.0.1:8787/"));
        assert!(is_safe_worker_url("http://[::1]:8787"));

        assert!(!is_safe_worker_url("http://[2001:db8::1]:8787"));
        assert!(!is_safe_worker_url("http://jotter.example.com"));
        assert!(!is_safe_worker_url("http://192.168.1.10:8787"));
        // A host merely starting with "localhost" is a different host.
        assert!(!is_safe_worker_url("http://localhost.evil.example"));
        assert!(!is_safe_worker_url("ftp://x.example"));
        assert!(!is_safe_worker_url("jotter.example.com"));
    }

    #[test]
    fn endpoint_needs_both_url_and_token_and_normalizes_the_url() {
        let mut cfg = SyncConfig::default();
        assert!(cfg.endpoint().is_none());
        cfg.url = "https://x.example/".into();
        assert!(cfg.endpoint().is_none());
        cfg.token = "tok".into();
        assert_eq!(
            cfg.endpoint(),
            Some(("https://x.example".to_string(), "tok"))
        );
    }

    #[test]
    fn read_json_degrades_to_defaults_and_round_trips() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("cfg.json");
        let missing: SyncConfig = read_json(Ok(path.clone()));
        assert!(missing.url.is_empty());

        fs::write(&path, "{ not json").unwrap();
        let corrupt: SyncConfig = read_json(Ok(path.clone()));
        assert!(corrupt.url.is_empty());

        let mut cfg = SyncConfig::default();
        cfg.url = "https://x.example".into();
        write_json(&path, &cfg).unwrap();
        let back: SyncConfig = read_json(Ok(path.clone()));
        assert_eq!(back.url, "https://x.example");

        let unreadable: SyncConfig = read_json(Err("no dir".into()));
        assert!(unreadable.url.is_empty());
    }

    #[test]
    fn normalize_url_trims_space_and_trailing_slashes() {
        assert_eq!(
            normalize_url("  https://x.example///  "),
            "https://x.example"
        );
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

    #[test]
    fn remote_supersedes_only_when_strictly_newer() {
        assert!(remote_supersedes(11, 10)); // remote newer -> adopt
        assert!(!remote_supersedes(10, 10)); // tie -> already have it, don't re-fetch
        assert!(!remote_supersedes(9, 10)); // local newer -> keep local (push handles it)
    }

    #[test]
    fn delete_wins_unless_local_edited_after() {
        assert!(delete_wins(10, 10)); // tie -> delete wins (converge to deleted)
        assert!(delete_wins(5, 10)); // local older than delete -> delete
        assert!(!delete_wins(11, 10)); // local edited after delete -> resurrect
    }

    // --- integration: sync_core against a mock worker on a tempdir ---

    use tempfile::TempDir;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn mk_draft(id: &str, content: &str, updated_at: i64) -> Draft {
        Draft {
            id: id.into(),
            content: content.into(),
            updated_at,
            ..Default::default()
        }
    }

    fn drafts_list(entries: serde_json::Value) -> ResponseTemplate {
        ResponseTemplate::new(200).set_body_json(serde_json::json!({ "drafts": entries }))
    }

    #[tokio::test]
    async fn sync_core_pushes_a_new_local_draft() {
        let dir = TempDir::new().unwrap();
        write_draft_in(dir.path(), &mk_draft("draft-a", "hi", 100)).unwrap();
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/drafts"))
            .respond_with(drafts_list(serde_json::json!([])))
            .mount(&server)
            .await;
        Mock::given(method("PUT"))
            .and(path("/drafts/draft-a"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;

        let (changed, synced, pushed) = sync_core(
            http_client(),
            &server.uri(),
            "tok",
            dir.path(),
            HashMap::new(),
            &HashMap::new(),
        )
        .await
        .unwrap();

        assert!(!changed); // a push doesn't touch local disk
        assert_eq!(synced.get("draft-a"), Some(&100)); // recorded as synced
        assert!(pushed.is_empty());
    }

    #[tokio::test]
    async fn sync_core_skips_local_only_file_draft() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("note.txt");
        let mut d = mk_draft("draft-f", "local only", 100);
        d.file_path = Some(path_str(&file)); // opened from disk, not opted in
        write_draft_in(dir.path(), &d).unwrap();
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/drafts"))
            .respond_with(drafts_list(serde_json::json!([])))
            .mount(&server)
            .await;
        // No PUT mock: a push of this draft would 404 and never land in `synced`.

        let (_, synced, pushed) = sync_core(
            http_client(),
            &server.uri(),
            "tok",
            dir.path(),
            HashMap::new(),
            &HashMap::new(),
        )
        .await
        .unwrap();

        assert!(!synced.contains_key("draft-f")); // never pushed -> not recorded
        assert!(pushed.is_empty());
    }

    #[tokio::test]
    async fn sync_core_pulls_a_new_remote_draft() {
        let dir = TempDir::new().unwrap();
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/drafts"))
            .respond_with(drafts_list(
                serde_json::json!([{ "id": "draft-b", "updatedAt": 200, "deleted": false }]),
            ))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/drafts/draft-b"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": "draft-b", "title": "", "content": "from remote",
                "file_path": null, "created_at": 1, "updated_at": 200
            })))
            .mount(&server)
            .await;

        let (changed, synced, _) = sync_core(
            http_client(),
            &server.uri(),
            "tok",
            dir.path(),
            HashMap::new(),
            &HashMap::new(),
        )
        .await
        .unwrap();

        assert!(changed); // wrote a new local file
        assert_eq!(synced.get("draft-b"), Some(&200));
        let on_disk = read_all_drafts_in(dir.path()).unwrap();
        assert_eq!(on_disk.len(), 1);
        assert_eq!(on_disk[0].content, "from remote");
    }

    #[tokio::test]
    async fn sync_core_applies_a_remote_delete() {
        let dir = TempDir::new().unwrap();
        write_draft_in(dir.path(), &mk_draft("draft-d", "old", 100)).unwrap();
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/drafts"))
            .respond_with(drafts_list(
                serde_json::json!([{ "id": "draft-d", "updatedAt": 200, "deleted": true }]),
            ))
            .mount(&server)
            .await;

        let (changed, synced, _) = sync_core(
            http_client(),
            &server.uri(),
            "tok",
            dir.path(),
            HashMap::new(),
            &HashMap::new(),
        )
        .await
        .unwrap();

        assert!(changed);
        assert!(read_all_drafts_in(dir.path()).unwrap().is_empty()); // file removed
        assert_eq!(synced.get("draft-d"), Some(&200));
    }

    #[tokio::test]
    async fn sync_core_resurrects_locally_newer_draft_over_remote_delete() {
        let dir = TempDir::new().unwrap();
        write_draft_in(dir.path(), &mk_draft("draft-e", "kept", 300)).unwrap();
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/drafts"))
            .respond_with(drafts_list(
                serde_json::json!([{ "id": "draft-e", "updatedAt": 200, "deleted": true }]),
            ))
            .mount(&server)
            .await;
        // local (300) is newer than the delete (200) -> keep and push it back.
        Mock::given(method("PUT"))
            .and(path("/drafts/draft-e"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;

        let (changed, synced, _) = sync_core(
            http_client(),
            &server.uri(),
            "tok",
            dir.path(),
            HashMap::new(),
            &HashMap::new(),
        )
        .await
        .unwrap();

        assert!(!changed); // file kept, not removed or rewritten
        assert_eq!(read_all_drafts_in(dir.path()).unwrap().len(), 1);
        assert_eq!(synced.get("draft-e"), Some(&300)); // pushed
    }

    #[tokio::test]
    async fn sync_core_pushes_a_tombstone_delete() {
        let dir = TempDir::new().unwrap();
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/drafts"))
            .respond_with(drafts_list(serde_json::json!([])))
            .mount(&server)
            .await;
        Mock::given(method("DELETE"))
            .and(path("/drafts/draft-c"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;

        let mut tombstones = HashMap::new();
        tombstones.insert("draft-c".to_string(), 300i64);
        let (_, synced, pushed) = sync_core(
            http_client(),
            &server.uri(),
            "tok",
            dir.path(),
            HashMap::new(),
            &tombstones,
        )
        .await
        .unwrap();

        assert_eq!(pushed, vec!["draft-c".to_string()]);
        assert_eq!(synced.get("draft-c"), Some(&300));
    }

    #[tokio::test]
    async fn a_draft_awaiting_its_own_delete_is_not_pulled_back() {
        // The worker still lists a draft this device has deleted, right up
        // until our DELETE goes out later in the same pass. Downloading it
        // first put it back in the sidebar for a whole sync interval.
        let dir = TempDir::new().unwrap();
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/drafts"))
            .respond_with(drafts_list(serde_json::json!([
                { "id": "draft-c", "updatedAt": 300, "deleted": false }
            ])))
            .mount(&server)
            .await;
        // Fetching the body would be the bug; this mock must never be hit.
        Mock::given(method("GET"))
            .and(path("/drafts/draft-c"))
            .respond_with(ResponseTemplate::new(200))
            .expect(0)
            .mount(&server)
            .await;
        Mock::given(method("DELETE"))
            .and(path("/drafts/draft-c"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;

        let mut tombstones = HashMap::new();
        tombstones.insert("draft-c".to_string(), 300i64);
        let (_, _, pushed) = sync_core(
            http_client(),
            &server.uri(),
            "tok",
            dir.path(),
            HashMap::new(),
            &tombstones,
        )
        .await
        .unwrap();

        assert_eq!(pushed, vec!["draft-c".to_string()]);
        assert!(!draft_path(dir.path(), "draft-c").exists());
    }

    #[tokio::test]
    async fn a_remote_delete_does_not_remove_a_draft_that_no_longer_syncs() {
        // Opting a file out records a tombstone; the worker echoes it back as
        // deleted. Applying that here removed the local draft two passes later,
        // taking its title, pin and mtime with it.
        let dir = TempDir::new().unwrap();
        let mut d = draft("kept locally", Some("/tmp/kept.md"));
        d.id = "draft-local".into();
        d.updated_at = 100;
        d.cloud = false; // opted out, so remote deletions do not apply
        let json = serde_json::to_string(&d).unwrap();
        fs::write(draft_path(dir.path(), "draft-local"), json).unwrap();

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/drafts"))
            .respond_with(drafts_list(serde_json::json!([
                { "id": "draft-local", "updatedAt": 200, "deleted": true }
            ])))
            .mount(&server)
            .await;

        sync_core(
            http_client(),
            &server.uri(),
            "tok",
            dir.path(),
            HashMap::new(),
            &HashMap::new(),
        )
        .await
        .unwrap();

        assert!(
            draft_path(dir.path(), "draft-local").exists(),
            "a draft that does not sync must survive a remote delete"
        );
    }

    #[tokio::test]
    async fn sync_core_surfaces_auth_failure() {
        let dir = TempDir::new().unwrap();
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/drafts"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&server)
            .await;

        let result = sync_core(
            http_client(),
            &server.uri(),
            "wrong",
            dir.path(),
            HashMap::new(),
            &HashMap::new(),
        )
        .await;
        assert!(result.is_err()); // 401 on the pull list -> Err (drives sync:status error)
    }
}
