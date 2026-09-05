# Changelog

The source for each GitHub release's notes, which is also what the website's
changelog page reads. That page keeps the bullets and drops the headings, and it
reads line by line — so every bullet stays on one line, however long, and makes
sense without its heading. Only the opening paragraph is prose.

## v0.5.2

The release that makes Jotter safe to keep your notes in: writes that cannot be
half-finished, a quit that waits for your last keystroke, and a sync that no
longer deletes what it should leave alone. The editor caught up too — files from
the Finder, focus mode, a sidebar you can move, and a keyboard that reaches
everything. And it has a new icon.

### A new icon

- **Jotter has one mark now, not two.** The app shipped a blue gradient tile with a document card on it; the website showed a flat paper square. They shared no shape, no palette and no idea, so downloading from the site got you something that looked like a different program.
- **The mark is `txt` with a text cursor after it** — the file format this app is actually about, drawn in its own paper, ink and blue rather than a colour scheme borrowed from nowhere. It reduces to `t|` on smaller sizes and to the cursor alone in a browser tab, so the same mark holds from 1024 pixels down to 16.

### Your notes are harder to lose

- **Every write is now atomic** — a note and its file are written whole or not at all, so a crash can no longer leave a half-written note behind, and a file's permissions survive the write.
- **Autosave no longer overwrites an edit you made in another program.** If the file changed on disk since Jotter last read it, the save stops and offers to reload the disk copy or keep yours — and parks your text in a "(conflicted copy)" file first, so neither version is lost.
- **Quitting waits for your last keystroke**, along with any delete still inside its undo window and a final sync. Type a word, press ⌘Q, and the word is there next time.
- **Sync no longer deletes drafts it should have left alone**, and a save made while a sync is downloading is no longer overwritten by the older copy that download was already carrying.
- **Fixed a bug that could open a note into an empty editor** and then autosave that emptiness over it. Every read and write of the editor now goes through one guarded path.
- **A note you renamed and later cleared out is kept**, instead of being pruned on the next launch.

### Files on disk

- **Open files from the Finder** — double-click, "Open With", or drag onto the window. `.txt` and `.md` files are associated with Jotter.
- **Save As**, and **Show in Finder** for any note backed by a file.
- **The drafts folder can be moved** (Settings → Storage). Existing notes are copied across, and pointing two Macs at one synced folder merges rather than overwrites.
- **The same file can no longer open in two tabs** because its path was spelled two different ways.

### The editor

- **Focus mode** (⌃⌘F) leaves nothing but the text. Escape arms the exit, a second Escape leaves, and it can go full screen if you want.
- **Tab indents** the lines you selected and Shift+Tab takes it back out, with a tab character or 2 or 4 spaces. Escape then Tab always moves focus, so the editor is never a keyboard trap.
- **A resizable sidebar** with a toggle button, and the macOS traffic lights now line up with the tab bar.
- **Tabs, sidebar rows, the context menu and the overlays are all keyboard usable** — arrow keys, Enter and Escape throughout, with keyboard focus shown as a fill rather than a ring.

### Cloud sync

- **Sync is opt-in per file for notes opened from disk.** Notes written in Jotter sync as before; a file on your machine stays there until you choose "Sync to Cloud" for it, and "Stop Syncing to Cloud" takes a note back out of the cloud rather than only ceasing to update it.
- **A worker URL must be https** (loopback excepted), and a refusal now says why.

### Underneath

- **A Content Security Policy**, with no inline styles or scripts in the shipped build.
- **The app can only touch files you picked** — every read and write is checked against the paths that came from a dialog, a drop, an "Open With", or your own store, and the file dialogs are opened outside the page.
- **Launch reads the store in parallel**, and typing no longer rebuilds the whole sidebar.
- **196 frontend tests, 47 Rust tests and 43 end-to-end cases** that drive the real app — one of them opens a store written by the previous version to prove an upgrade keeps every note.

### Upgrading

- **Your notes are read exactly as they are** — nothing is migrated or moved.
- **If you use cloud sync, notes opened from files are no longer backed up automatically.** Turn it on per note with "Sync to Cloud". Nothing already in the cloud is deleted; those copies simply stop updating.

## v0.4.0 and earlier

See the [releases page](https://github.com/byurhannurula/jotter/releases).
