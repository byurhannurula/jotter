<div align="center">

<img src="src-tauri/icons/128x128@2x.png" width="88" alt="Jotter icon" />

# Jotter

**A fast, minimal notepad — a quiet place for quick thoughts.**

[![Download](https://img.shields.io/badge/Download-Latest%20Release-0a84ff?style=for-the-badge&logo=apple&logoColor=white)](https://github.com/byurhannurula/jotter/releases/latest)

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-0a84ff.svg)](LICENSE)
[![Built with Tauri](https://img.shields.io/badge/Built%20with-Tauri%202-24c8db.svg)](https://tauri.app)

</div>

Open it and start typing. No "where do you want to save this?" dialog, no account, no cloud. Every scratch is auto‑kept in a local drafts store, so you never lose a note by starting a new one. When a draft graduates into a real file, `⌘S` gives it a home — the only time a save dialog appears.

Built with [Tauri 2](https://tauri.app) (Rust) + vanilla JS. Tiny bundle, native WebKit, instant startup.

<!-- ![Jotter](docs/screenshot.png) -->

> [!NOTE]
> Jotter is built for my **personal use on macOS**. Windows and Linux binaries are produced by CI but are **not tested** — they may work, but no promises. Bug reports and PRs are welcome.

## Install

### Download

Or grab the latest build from the [**Releases**](https://github.com/byurhannurula/jotter/releases/latest) page — macOS `.dmg`, Windows `.exe`/`.msi`, Linux `.AppImage`/`.deb`/`.rpm`.

### Homebrew
Install via the Homebrew tap:
```bash
brew install --cask byurhannurula/tap/jotter
```

Update later with:
```bash
brew upgrade --cask jotter
```

### First launch

The app isn't code‑signed / notarized (no paid developer accounts), so the OS warns on first launch **regardless of install method**:

- **macOS** — Gatekeeper blocks it. Open **System Settings → Privacy & Security**, scroll to the *"Jotter.app was blocked"* message, and click **Open Anyway** (authenticate, then confirm). It's trusted from then on. Or, from Terminal: `xattr -dr com.apple.quarantine /Applications/Jotter.app`. _(On macOS 14 and earlier you can instead right‑click the app → Open.)_
- **Windows** — SmartScreen may warn: **More info → Run anyway**.
- **Linux** — AppImage: `chmod +x Jotter*.AppImage` then run; or install the `.deb`.

## Features

- **Type instantly on launch** — a fresh page every time; past notes live in the sidebar
- **Autosaved drafts** — nothing is ever lost; browse and search them in the sidebar (`⌘B`)
- **Tabs** — VSCode‑style; `⌘T` new, `⌘W` close, `⌃Tab` to cycle, `⌘⇧T` to reopen a closed one
- **Quick switcher** (`⌘P`) — jump to any draft by name or content
- **Markdown preview** — per‑tab Edit ⇄ Preview toggle (`⇧⌘P`)
- **Find & Replace** (`⌘F`)
- **Status bar** — line/column + word & character count (toggleable)
- **Soft‑delete** — deleting a draft leaves an Undo, so nothing goes by accident
- **Settings** — a sectioned surface: theme, font, text size, word wrap, editor margins (Cozy/Wide), and a full keyboard‑shortcut reference. Every piece of chrome is show/hide‑able
- **Native feel** — overlay titlebar, light/dark, sizes to your display on first run then remembers your size
- Small (~9 MB), fast, and everything stays on your machine



## Usage

Open the app and just type — the current note autosaves as you go. Use the sidebar to revisit past notes and tabs to keep a few open at once.

The full keyboard-shortcut reference lives in the app: **Settings → Shortcuts** (`⌘,`).

**How saving works**

- **Autosave** — changes are written ~400 ms after your last keystroke. There's no "unsaved" state.
- **Drafts store** — every note is a small JSON file in the app's data directory (`~/Library/Application Support/com.byrhn.jotter/drafts/`). A note appears in the sidebar as soon as it has content; empty, untouched notes are never saved.
- **Real files, on demand** — `⌘S` writes the current draft to a `.txt`/`.md` file wherever you choose. After that, autosave keeps that file up to date too.
- **Fresh page on launch** — opening the app always gives you a clean page; your previous notes are one click away in the sidebar.

## Build from source

**Prerequisites:** [Rust](https://rustup.rs) (stable), [Node.js](https://nodejs.org) 22+ and [pnpm](https://pnpm.io), plus the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS (Xcode Command Line Tools on macOS).

```bash
pnpm install
pnpm tauri dev      # hot-reloading dev build
pnpm tauri build    # release bundle → src-tauri/target/release/bundle/
pnpm ship           # macOS: build + copy Jotter.app to /Applications
```

**Tests:**

```bash
pnpm test                   # Vitest — pure logic (title/preview/search/…)
cd src-tauri && cargo test  # Rust unit tests (store/serde)
```

**Releasing** (maintainer):

```bash
pnpm release patch   # 0.2.0 → 0.2.1
pnpm release minor   # 0.2.0 → 0.3.0
pnpm release major   # 0.2.0 → 1.0.0
pnpm release patch --dry-run   # preview the bump, change nothing
```

Bumps the version in all four files (`package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src/lib/meta.js`), runs the test suites, then commits, tags `vX.Y.Z`, and pushes. The tag push triggers CI, which builds installers for macOS/Windows/Linux and drafts a GitHub Release; publishing that draft updates the Homebrew tap automatically. Runs only from a clean `main`.

## Project structure

```
src/                  frontend (vanilla JS, no framework)
  main.js             app logic (drafts, tabs, find, settings, preview)
  lib/text.js         pure helpers (unit-tested)
  lib/meta.js         app name + author links (edit here for the About dialog)
src-tauri/src/lib.rs  Rust host: drafts store commands + native menu
.github/workflows/    cross-platform release CI
```

## Roadmap

Shipped in v0.2:

- [x] Status bar — line/column + word & character count
- [x] Reopen last closed tab (`⌘⇧T`)
- [x] Quick draft switcher (`⌘P`)
- [x] Configurable editor margins (Cozy / Wide)
- [x] Soft-delete — undo an accidental draft delete
- [x] Homebrew install + one‑command releases

Under consideration — ideas and PRs welcome:

- [ ] Optional cloud sync — back up & sync drafts across devices (self‑hostable Worker + R2, opt‑in)
- [ ] Read-only sharing — a private link that renders a note as a clean web page
- [ ] Edit history — browse and restore earlier versions of a draft
- [ ] Auto-update (Tauri updater) — in‑app "check for updates"
- [ ] Right-click actions — Export (md/txt/html), Reveal in Finder, Copy path/name
- [ ] Recent-tab switching — Alt+Tab-style, most-recently-used order
- [ ] Split view — open two notes side by side
- [ ] Unified sidebar — show saved files alongside drafts (drop ones that no longer exist)

## Author

Made by **Byurhan Nurula** — [Website](https://byurhannurula.com/) · [X](https://x.com/byurhannurula)
