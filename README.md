# Notepad

A fast, minimal notepad — a quiet place for quick thoughts.

Open it and start typing. No "where do you want to save this?" dialog, no account, no cloud. Every scratch is auto‑kept in a local drafts store, so you never lose a note by starting a new one. When a draft graduates into a real file, `⌘S` gives it a home — that's the only time a save dialog appears.

Built with [Tauri 2](https://tauri.app) (Rust) + vanilla JS. Tiny bundle, native WebKit, instant startup.

![Notepad](docs/screenshot.png)

## Features

- **Type instantly on launch** — fresh page every time; past notes live in the sidebar
- **Autosaved drafts** — nothing is ever lost; browse/search them in the sidebar (`⌘B`)
- **Tabs** — VSCode‑style; `⌘T` new, `⌘W` close, `⌃Tab` to cycle
- **Markdown preview** — per‑tab Edit ⇄ Preview toggle (`⇧⌘P`)
- **Find & Replace** (`⌘F`)
- **Settings** — theme (system/light/dark), font (system/serif/mono/rounded), text size, word wrap
- **Native feel** — overlay titlebar, light/dark, remembers window size
- Small (~9 MB app), fast, everything stored locally

## How it works

Everything stays **local** — no account, no sync, no cloud.

- **Autosave.** As you type, changes are written automatically ~400 ms after your last keystroke. There's no "unsaved" state and no `⌘S` ritual for everyday notes.
- **Drafts store.** Every note is a small JSON file in the app's data directory (`~/Library/Application Support/com.byrhn.mac-notepad/drafts/` on macOS). The sidebar (`⌘B`) lists them newest‑first; a note shows up there as soon as it has content.
- **Fresh page on launch.** Opening the app always gives you a clean page so you can type immediately — your previous notes are one click away in the sidebar. Empty, untouched notes are never saved and are pruned automatically.
- **Real files, on demand.** `⌘S` / `⌘⇧S` writes the current draft to a `.txt`/`.md` file wherever you choose — the only time a save dialog appears. After that, autosave keeps that file up to date too.
- **Tabs vs. drafts.** Tabs across the top are what's currently open; the sidebar is everything you've ever written. Click a sidebar item to open it in a tab.

Because it's a plain `<textarea>` over a tiny native shell, startup is instant and typing stays snappy even in long notes (spellcheck auto‑disables past ~20k characters to avoid WebKit lag).

## Install

Grab a build for your OS from the [Releases](https://github.com/byurhannurula/just-notepad/releases) page.

- **macOS** — the app is not notarized (no paid Apple Developer account), so the first launch needs **right‑click → Open** once. After that it opens normally.
- **Windows** — Windows may show a SmartScreen "unknown publisher" prompt; choose **More info → Run anyway**.
- **Linux** — an AppImage (`chmod +x`, then run) and a `.deb` are provided.

## Build from source

### Prerequisites

- [Rust](https://rustup.rs) (stable)
- [Node.js](https://nodejs.org) 18+ and [pnpm](https://pnpm.io) (`npm i -g pnpm`)
- **macOS:** Xcode Command Line Tools (`xcode-select --install`)
- **Linux:** the [Tauri system dependencies](https://tauri.app/start/prerequisites/#linux) (webkit2gtk, etc.)
- **Windows:** the [Microsoft C++ Build Tools + WebView2](https://tauri.app/start/prerequisites/#windows)

### Develop

```bash
pnpm install
pnpm tauri dev      # hot-reloading dev build
```

### Build a release

```bash
pnpm tauri build            # bundles for the current OS
# → src-tauri/target/release/bundle/
```

On macOS you can also install straight into `/Applications`:

```bash
pnpm ship                   # build + copy Notepad.app to /Applications
```

### Test

```bash
pnpm test                   # Vitest — pure logic (title/preview/search/…)
cd src-tauri && cargo test  # Rust unit tests (store/serde)
```

## Project structure

```
src/                  frontend (vanilla JS, no framework)
  index.html          editor + panel markup
  main.js             app logic (drafts, tabs, find, settings, preview)
  styles.css
  lib/
    text.js           pure helpers (unit-tested)
    text.test.js
    meta.js           app name + author links (edit here for the About dialog)
src-tauri/            Rust host
  src/lib.rs          commands (drafts store) + native menu
  tauri.conf.json     window + bundle config
.github/workflows/    cross-platform release CI
```

Drafts are stored as JSON under the OS app-data dir (e.g. `~/Library/Application Support/com.byrhn.mac-notepad/drafts/` on macOS).

## Releasing

Pushing a `v*` tag triggers the GitHub Actions workflow, which builds for macOS (Apple Silicon + Intel), Windows, and Linux and attaches the artifacts to a GitHub Release. See [.github/workflows/release.yml](.github/workflows/release.yml).

```bash
# bump versions in package.json + src-tauri/tauri.conf.json + src/lib/meta.js first
git tag v0.1.0
git push origin v0.1.0
```

## Roadmap

Small things under consideration — contributions and ideas welcome:

- [ ] Status bar — line/column + word & character count
- [ ] Reopen last closed tab (`⌘⇧T`)
- [ ] Quick draft switcher (`⌘P`)
- [ ] Export / "Reveal in Finder" for a draft
- [ ] Configurable editor margins (Cozy / Wide)
- [ ] Soft-delete — undo an accidental draft delete
- [ ] Auto-update (Tauri updater)
- [ ] Homebrew cask install

Larger: a [CodeMirror 6](https://codemirror.net/) editor core to unlock live markdown styling, code syntax highlighting, and smooth editing of very large files.

## License

[AGPL-3.0-or-later](LICENSE). You're free to use, study, modify, and share it — but derivative works (including network-hosted ones) must also be open under the AGPL. In short: build on it, don't repackage it as a closed product.

## Author

Made by **Byurhan Nurula** — [website](https://byurhannurula.com/) · [X](https://x.com/byurhannurula) · [GitHub](https://github.com/byurhannurula)
