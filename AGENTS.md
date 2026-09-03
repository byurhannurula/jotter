# AGENTS.md

## Project overview

Jotter is a fast, minimal notepad — a fresh page on every launch, past notes in a
sidebar, autosaved to an app-managed drafts store (no "where do you want to save
this?" dialog). Built with **Tauri 2** (Rust host + WKWebView) and **vanilla JS +
Vite** — no frontend framework.

- **Primary target:** macOS. Windows/Linux binaries are produced by CI but untested.
- **productName:** `Jotter` · **bundle id:** `com.byrhn.jotter`
- **Rust crate:** `jotter` (lib `jotter_lib`). The `src-tauri` folder still holds the crate.
- **License:** AGPL-3.0-or-later.

## Build & run

Requires **Node 22+** (pnpm 11 uses `node:sqlite`, needs ≥22.13), Rust stable, pnpm,
and the Tauri prerequisites (Xcode Command Line Tools on macOS).

```bash
pnpm install
pnpm tauri dev      # hot-reloading dev app  (use THIS to verify UI, not `pnpm dev`)
pnpm tauri build    # release bundle → src-tauri/target/release/bundle/
pnpm ship           # macOS: build + copy Jotter.app to /Applications
pnpm build          # frontend only (Vite) — quick syntax/build check
```

The frontend calls `invoke("init_store")` on boot, so it **cannot run in a plain
browser** — verify in `pnpm tauri dev`. `pnpm build` only checks that the frontend
compiles.

## Test

```bash
pnpm test                                    # Vitest — lib/*.test.js + src/app.test.js
cargo test --manifest-path src-tauri/Cargo.toml   # Rust — store, sync engine, paths
```

Keep both green before committing. Three layers:

- **Pure units** in `src/lib/*.js`, each with a `*.test.js` beside it: `text.js`
  (title/preview/search/indent), `tabs.js` (the tab model: open/close/cycle/reopen
  as state transitions), `keys.js` (what a keypress means), `paths.js` (how a
  path is shown), `sync-reconcile.js`, `sync-ui.js`. New logic goes here first.
  `empty-drafts.json` is read by both `text.test.js` and the Rust `is_orphan`
  test, so the prune rule stays one rule.
- **App wiring** in `src/app.test.js` (happy-dom): boots the real `main.js` against
  a fake Rust host built on `@tauri-apps/api/mocks` (`src/app-harness.js`), then
  drives it through sidebar clicks, menu events, context menus, toasts and typing.
  Asserts the editor always shows the active tab's text and nothing is ever written
  over a note. Add a case here for any change to how tabs, drafts and the editor
  connect. Never dispatch keyboard events on `document` from these tests; earlier
  module instances keep their listeners.
- **Random sessions** in `src/app.random.test.js` (fast-check): random sequences of
  open, close, cycle, reopen, type, rename, pin, delete, undo, an outside edit to
  the file-backed draft, Reload / Keep mine on the conflict toast, a sync landing,
  and pauses, against the real app, with an oracle checked after every step
  (editor text, tab list, sidebar order, store and disk copies, every save's
  content, the conflict toast). Runs 6 sessions by default;
  `JOTTER_FUZZ_RUNS=200 pnpm test -- app.random` for a deep run, and
  `JOTTER_FUZZ_SEED=<n> JOTTER_FUZZ_PATH=<replayPath>` replays one reported
  failure. A failure is shrunk to the shortest sequence; decide whether the app
  or the model is wrong, then add the sequence to `app.test.js` as a scripted case
  next to the fix.
- **Rust** in `lib.rs` `mod tests`: store and atomic writes on a `TempDir`,
  `sync_core` against a wiremock server, path canonicalisation.

CI runs the JS suite, the format check, and the Rust suite (Linux only) on every
push. Release runs Rust on all three OSes.

## Architecture

**Frontend (`src/`)**

- `main.js` — DOM and IPC wiring: rendering, event handlers, find & replace,
  markdown preview (per-tab), the settings registry, quick switcher, status bar,
  soft-delete, focus mode, the drafts-folder and Cloud settings. One file on
  purpose; keep it organized by the existing section comments. Two rules that
  came from a data-loss bug: only `activate()` and `showInEditor()` change which
  draft the editor shows, and every read of `editor.value` that flows into a draft
  goes through `editorTextFor(id)`. A third: only drafts in the `unsaved` set are
  written by a flush, so switching tabs never rewrites a note nobody typed in
  (a sync client would see an edit, and a file changed outside would raise a
  conflict the user never caused).
- `lib/tabs.js` — the tab model as pure transitions (`openInTab`, `closeTab`,
  `cycleTab`, `reopenClosedTab`, `removeDraftFromView`, `dropScratch`). `main.js`
  snapshots its globals, runs a transition, writes the result back, then does the
  effects.
- `lib/modals.js` — one stack for the overlays (settings, switcher, prompt): Escape
  closes the top one, Tab stays inside, focus returns to the opener on close. Also
  `roveFocus`, the roving-tabindex helper the tab bar, sidebar rows and context
  menu share. Keyboard rule: the tab bar and sidebar are one tab stop each; arrows
  move, Enter opens and sends focus to the editor, Backspace closes or deletes.
- `lib/keys.js` — keyboard decisions (`tabKeyAction`: Tab indents, Escape then Tab
  leaves the editor; `CHORDS` + `shortcutOf`: the page-owned chords such as
  ⌃Tab and ⇧⌘L, one document handler switches on the id). `lib/text.js` — pure
  text helpers. `lib/paths.js` — `dirName`, `tildePath`, `shortPath`. `lib/meta.js` — app
  name/version/author links (drives the About screen; the release script bumps
  `version` here).
- `index.html` / `styles.css`. `--titlebar-h` in the CSS must match `TITLEBAR_H` in
  `lib.rs` (the macOS traffic lights are positioned from it).

**Rust host (`src-tauri/src/lib.rs`)**

- Drafts-store commands: `init_store`, `save_draft`, `delete_draft`, `read_text_file`,
  `write_text_file`, `canonical_path`, `write_conflict_copy`, `get_drafts_dir`,
  `set_drafts_dir`, `open_drafts_dir`. Sync: `sync_now`, `list_drafts`,
  `synced_ids`, `set_cloud`, the `*_sync_config` pair, and the share
  commands. Open-with: `take_opened_files` drains files buffered before the webview
  was ready; later opens arrive as the `open-files` event.
- Native menu built once in `build_menu`; menu clicks `emit("menu", <id>)` to the
  webview, handled by the `listen("menu", …)` switch in `main.js`.
- Store lives at `app_data_dir()/drafts/<id>.json`, one file per draft, unless
  `app_data_dir()/store.json` points it elsewhere (Settings → Drafts folder). All
  writes go through `write_atomic` (temp sibling + rename). `sync.json`,
  `shares.json`, `window.json` stay in `app_data_dir()`.
- A file-backed draft carries `file_mtime`; `save_draft` refuses with `"conflict"`
  when the file on disk has a different mtime, and the frontend parks the editor
  text as `name (conflicted copy).ext` before asking Reload or Keep mine.

**Persistence model:** every launch opens a fresh blank page; saved drafts appear in
the sidebar. Autosave writes ~400 ms after the last keystroke. `⌘S` also writes a real
`.txt`/`.md` file wherever the user chooses.

## Conventions

- **Vanilla JS, no framework.** The only runtime JS dep is `markdown-it`. Don't
  introduce React/Vue/build-time frameworks.
- **Settings registry.** All settings go through the `SETTINGS` object in `main.js`
  (`{ section, label, def, apply, options?, control? }`, control = `seg` | `toggle`),
  persisted in `localStorage` under `set-*`. Everything is show/hide-able — new chrome
  should get a toggle, not be forced on.
- **Menu accelerators are static.** The native menu is built once in Rust. Features
  driven by a menu shortcut check their setting flag in the JS `menu` handler and
  no-op when disabled — do not rebuild the menu at runtime.
- **Theming via CSS custom properties.** Colors live in four blocks that must stay in
  sync: `:root`, `@media (prefers-color-scheme: dark)`, `html[data-theme="light"]`,
  `html[data-theme="dark"]`. Update all four (the `@media` and `[data-theme=dark]`
  blocks use different indentation — a `replace_all` won't catch both).
- **No emojis** in code, comments, or commit messages. **No new README/docs files**
  unless explicitly requested. Plan and review docs go in `plans/` (gitignored).

## Performance

The editor must stay snappy on large pastes/docs. Keep these invariants:

- Per-keystroke work is cheap; heavy UI updates are coalesced to one
  `requestAnimationFrame` (`flushUi`). Don't add per-keystroke IPC or full re-renders.
- Read `editor.value` at most once per frame; prefer the model's `d.content` elsewhere.
- Spellcheck auto-disables above 20k chars (WebKit's main typing-lag source).

## Release

`pnpm release <patch|minor|major>` bumps the version in all four files, gates on
tests, tags, and pushes; CI builds every OS and drafts a GitHub Release. See the
`release` skill and `plans/plan-release-automation.md`. Builds are intentionally
**unsigned** — no notarization/signing steps unless an Apple Developer account exists.

## Commits

Atomic commits — one logical change each; don't bundle unrelated work. Verify `pnpm
test` + `cargo test` (and `pnpm build`) pass before committing. The maintainer prefers
to review and commit/release explicitly, so make the edits and let them commit unless
told otherwise.

## Gotchas (learned the hard way)

- **Titlebar dragging needs a capability, not just CSS.** `data-tauri-drag-region`
  is silently inert without `"core:window:allow-start-dragging"` in
  `src-tauri/capabilities/default.json`.
- **Vite 8 minifier.** Vite 8 (rolldown) dropped bundled esbuild — use
  `minify: true` in `vite.config.js`, not `"esbuild"`.
- **DMG build wants Automation access.** `pnpm tauri build` runs an AppleScript to
  lay out the DMG and asks for Finder control; pass `--bundles app` to skip it locally,
  or let CI build the DMGs.
- **Don't reuse a `.preview` class** for two different things — a past collision between
  the markdown container and the sidebar preview span caused layout breakage (the
  markdown container is `.md-view`).
