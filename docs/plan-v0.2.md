# Jotter v0.2 — Settings redesign + quick wins

Branch: `feature/settings-and-quick-wins`. This is a plan, not final code.

## Goals

Add a batch of small, high-value editor features and turn the cramped Settings sheet
into a **proper, sectioned Settings surface** that also hosts About and an Updates area.

**Every feature is toggleable from Settings** (show/hide or enable/disable), so each user
can keep the app as minimal as they want. Nothing is forced on.

All of this stays in the existing stack (vanilla JS + `main.js`, no framework). No new
runtime deps except possibly the Tauri updater later (out of scope here).

---

## Current state (for reference)

- **Settings** = a small modal (`#settings` sheet) with 4 segmented rows, driven by the
  `SETTINGS` object + `applyTheme/applyFont/applySize/applyWrap` + `getSetting/setSetting`
  in `src/main.js`. Persisted in `localStorage` (`set-*`).
- **About** = a separate modal (`#about`), populated from `src/lib/meta.js` in `initAbout()`.
- Modals use `openModal(id)/closeModal(id)` + `bindBackdrop(id)`.
- Drafts live in a `Map` + `openTabs[]`; `closeTab()`, `deleteDraft()` (with a native
  confirm), `renderTabs()/renderList()`, `activate()/openInTab()`.

---

## Everything is configurable (feature flags in Settings)

Each new feature reads a persisted flag and can be turned off. Existing chrome can become
toggleable too, so people can strip the app down.

| Setting | Values | Default | Effect when off |
| --- | --- | --- | --- |
| Status bar | show / hide | show | hide the bottom bar |
| Editor margins | cozy / wide | cozy | (choice, not on/off) |
| Delete behavior | undo toast / confirm dialog | undo | switch delete UX |
| Markdown preview button | show / hide | show | hide tab-bar button (still `⇧⌘P`) |
| Drafts sidebar button | show / hide | show | hide, still `⌘B` |

Quick switcher (`⌘P`) and Reopen closed tab (`⌘⇧T`) are **always on** — no toggle
(they're standard, zero-friction, and out of the way when unused).

**Mechanism (small extension of the current pattern):**
- Extend the `SETTINGS` registry with a `toggle` control type + boolean values (today it
  only has `seg`). `getSetting/setSetting/applyAllSettings` already generalize over it.
- Feature code reads `getSetting(name)` and renders/behaves accordingly (e.g. status bar
  adds/removes `body.no-statusbar`).
- The native menu is built once in Rust (static), so **menu-accelerator features check
  their flag in the JS event handler** and no-op when disabled (simplest; no runtime menu
  mutation). Optionally grey the menu item out later via the Tauri menu API.
- Defaults keep the app feeling complete out of the box; users opt *out*.

## 1. Settings redesign (do this first — it's the foundation)

**Why first:** margins, the status-bar toggle, About, and Updates all land inside it.

**UI:** a larger modal with a **left rail of sections** + a content pane (mini
System-Settings, matching the sectioned style). Sections:

- **General** — Appearance (theme); the behavior toggles (delete behavior,
  sidebar/preview-button visibility) from the flags table above.
- **Editor** — Font, Text size, Word wrap, **Margins (Cozy/Wide)** (feature #2), and the
  **Status bar** show/hide toggle (feature #3).
- **Shortcuts** — a reference list of every keybinding + action (feature #7).
- **Updates** — current version (from `APP.version`), a **Check for updates** button
  (v0.2: opens the Releases page via `openUrl`), and an **auto-update** toggle
  (disabled/placeholder until the real Tauri updater lands — see Out of scope).
- **About** — the current About content (icon, name, version, tagline, author links,
  license line, the egg) moved here from the separate modal.

**Implementation notes:**
- Keep the `SETTINGS` registry pattern; extend it to render controls into the right pane
  by section. Each setting keeps `{ key, def, apply }`; add a `section` + `label` +
  `control` type (`seg` | `toggle`).
- Replace the standalone About modal: `initAbout()` content moves into the About section
  renderer. The app-menu "About Jotter" and `⌘,` both open the settings window (About can
  be the default section for the menu's About item, General for `⌘,`).
- Left rail = simple button list toggling `.active`; content pane swaps section on click.
- Reuse `.seg` styles; add `.toggle` (already exists) and section/rail styles.
- Effort: **M–L** (biggest piece; ~half a day).

**Decision needed:** left-rail vs. a single scrollable sheet with section headers. Rail
matches the reference screenshot and scales better as sections grow — recommended.

## 2. Editor margins — Cozy / Wide (rides on Settings → Editor)

- New setting `margins` with values `cozy` (current tight ~24px) and `wide` (a centered
  reading column, e.g. `max-width: 720px` with auto side margins).
- Apply via a CSS var / body class: `applyMargins(v)` sets `--editor-pad-x` or toggles
  `body.margins-wide` (editor + `.md-view` both honor it).
- Effort: **S** (~30 min once Settings exists).

## 3. Status bar — Ln/Col + word & char count

- Thin `<footer class="statusbar">` under the editor/preview in the content pane.
- Shows `Ln x, Col y · W words · C chars`. In preview mode, drop Ln/Col.
- Compute in JS: Ln/Col from `editor.selectionStart` (count `\n` before caret; col =
  offset − last newline). Words = `content.trim().split(/\s+/)` (guard empty). Chars =
  `content.length`. Update on `input`/`keyup`/`click`/`select`, coalesced through the
  existing `requestAnimationFrame` (`flushUi`) path so it stays cheap on long docs.
- Toggle visibility via the Settings → Editor "Status bar" switch (`body.no-statusbar`).
- Effort: **S** (~1–2 h).

## 4. Reopen last closed tab (⌘⇧T)

- Keep a `closedStack` of recently-closed *draft ids* (only push meaningful/saved drafts;
  empty blanks are pruned and can't be restored).
- `closeTab()` pushes; `deleteDraft()` removes any matching id from the stack.
- New File-menu item **"Reopen Closed Tab"** `⌘⇧T` → emits `reopen_tab`; handler pops the
  stack and `openInTab(id)` (skip ids no longer in the drafts map).
- Effort: **S** (~1 h).

## 5. Quick draft switcher (⌘P)

- A command-palette modal (`#switcher`): search input + result list over **all** drafts.
- Fuzzy/substring filter on title + content (reuse `draftTitle` + a simple `includes`,
  or `findMatches`). Arrow keys move selection, Enter → `openInTab(id)`, Esc closes.
- Menu item **"Quick Open"** `⌘P` → emits `switcher`. Note: intercept so the webview's
  default print (⌘P) doesn't fire — the native menu accelerator handles this.
- Reuse the sidebar item markup/logic for rows.
- Effort: **M** (~2–3 h).

## 6. Soft-delete — undo an accidental draft delete

- Replace the blocking native confirm in `deleteDraft()` with an **immediate delete +
  Undo toast**.
- Flow: on delete → remove from map/UI + close its tab, stash the draft object in a
  `pendingDelete` map, start a ~6 s timer that then calls `invoke("delete_draft")` (actual
  disk removal). Show a toast: *"Draft deleted — Undo"*.
- **Undo** → cancel the timer, restore the draft to the map + `renderList()` (file was
  never removed yet, so nothing to rewrite).
- Needs a small **toast component** (see below).
- Effort: **M** (~2 h, incl. toast).

## 7. Shortcuts reference (Settings → Shortcuts)

- A read-only page listing every keybinding grouped by area (File, Edit, View, Tabs),
  generated from a single source-of-truth list in JS so it can't drift from reality.
- **Rebinding is optional/future.** It's harder than it looks: the shortcuts are *native
  menu accelerators* defined in Rust, so changing them at runtime means rebuilding the
  menu with new accelerators (Tauri menu API). v0.2 ships the **reference only**; custom
  keybindings are a later task (store overrides → re-emit the menu with them).
- Effort: **S** for the reference; rebinding = **L**, deferred.

## Shared infra

- **Toast**: a tiny bottom-center transient message with an optional action button
  (`showToast(msg, { actionLabel, onAction, timeout })`). Used by soft-delete now; handy
  later for "Saved", "Copied", update-available, etc. ~1 h.

---

## Suggested order

1. **Toast component** (tiny; unblocks soft-delete and future hints).
2. **Settings redesign** (foundation for margins, status-bar toggle, About, Updates).
3. **Editor margins** (rides on Settings → Editor).
4. **Status bar** (+ its toggle in Settings).
5. **Reopen closed tab**.
6. **Quick switcher**.
7. **Soft-delete** (uses the toast).

Each is independently shippable/committable on this branch.

## Rough effort

| Item | Size |
| --- | --- |
| Toast component | S |
| Settings redesign (rail + About + Updates) | M–L |
| Editor margins | S |
| Status bar | S |
| Reopen closed tab | S |
| Quick switcher | M |
| Soft-delete | M |

Total: roughly 1–1.5 focused days.

## Decisions (locked)

- **Settings layout:** left rail (mini System-Settings, like the reference screenshot). ✓
- **Updates section:** version + "Check for updates" → Releases + placeholder auto-update
  toggle now; real Tauri updater later. ✓
- **Status bar:** default **on** (with a show/hide toggle). ✓
- **Margins:** Cozy = current tight, Wide = centered reading column. ✓
- **Quick switcher / Reopen tab:** always on, no toggle. ✓
- **Shortcuts:** read-only reference page in v0.2; rebinding deferred. ✓

## Out of scope (later)

- Real **auto-updater** (Tauri updater plugin + release manifest + signing).
- **Homebrew cask**.
- **CodeMirror 6** editor core (live markdown/syntax highlighting, huge-file perf).
