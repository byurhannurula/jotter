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

    // Prune empty, unnamed orphans (e.g. blanks left by older versions).
    drafts.retain(|d| {
        let empty = is_orphan(d);
        if empty {
            if let Ok(p) = draft_file(&app, &d.id) {
                let _ = fs::remove_file(p);
            }
        }
        !empty
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
    write_draft(&app, &draft)
}

#[tauri::command]
fn delete_draft(app: AppHandle, id: String) -> Result<(), String> {
    let path = draft_file(&app, &id)?;
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(path).map_err(|e| e.to_string())
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
    let save = MenuItemBuilder::with_id("save", "Save…")
        .accelerator("CmdOrCtrl+S")
        .build(app)?;
    let save_as = MenuItemBuilder::with_id("save_as", "Save As…")
        .accelerator("Shift+CmdOrCtrl+S")
        .build(app)?;
    let close_tab = MenuItemBuilder::with_id("close_tab", "Close Tab")
        .accelerator("CmdOrCtrl+W")
        .build(app)?;

    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&new)
        .item(&new_tab)
        .separator()
        .item(&open)
        .separator()
        .item(&save)
        .item(&save_as)
        .separator()
        .item(&close_tab)
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

    let prev_tab = MenuItemBuilder::with_id("prev_tab", "Show Previous Tab")
        .accelerator("Control+Shift+Tab")
        .build(app)?;
    let next_tab = MenuItemBuilder::with_id("next_tab", "Show Next Tab")
        .accelerator("Control+Tab")
        .build(app)?;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            build_menu(app.handle())?;
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
            read_text_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
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
}

