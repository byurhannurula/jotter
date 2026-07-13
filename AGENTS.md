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
pnpm test                                    # Vitest — pure logic in src/lib/text.js
cargo test --manifest-path src-tauri/Cargo.toml   # Rust — drafts store / serde
```

Keep both green before committing. Pure, testable logic belongs in `src/lib/text.js`
(title/preview/search/relTime/findMatches) with a matching `*.test.js`.

## Architecture

**Frontend (`src/`)**
- `main.js` — all app logic: `drafts` Map + `openTabs[]`, tab/draft actions, find &
  replace, markdown preview (per-tab), the settings registry, quick switcher, status
  bar, and soft-delete. One file on purpose; keep it organized by the existing
  section comments.
- `lib/text.js` — pure helpers, unit-tested. `lib/meta.js` — app name/version/author
  links (drives the About screen; the release script bumps `version` here).
- `index.html` / `styles.css`.

**Rust host (`src-tauri/src/lib.rs`)**
- Drafts-store commands: `init_store`, `save_draft`, `delete_draft`, `read_text_file`.
- Native menu built once in `build_menu`; menu clicks `emit("menu", <id>)` to the
  webview, handled by the `listen("menu", …)` switch in `main.js`.
- Store lives at `app_data_dir()/drafts/<id>.json`, one file per draft.

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
  unless explicitly requested. Plan docs go in `docs/` and are left uncommitted unless
  asked.

## Performance

The editor must stay snappy on large pastes/docs. Keep these invariants:
- Per-keystroke work is cheap; heavy UI updates are coalesced to one
  `requestAnimationFrame` (`flushUi`). Don't add per-keystroke IPC or full re-renders.
- Read `editor.value` at most once per frame; prefer the model's `d.content` elsewhere.
- Spellcheck auto-disables above 20k chars (WebKit's main typing-lag source).

## Release

`pnpm release <patch|minor|major>` bumps the version in all four files, gates on
tests, tags, and pushes; CI builds every OS and drafts a GitHub Release. See the
`release-jotter` skill and `docs/plan-release-automation.md`. Builds are intentionally
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
