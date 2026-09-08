# Changelog

The source for each GitHub release's notes, which is also what the website's
changelog page reads. That page keeps the bullets and drops the headings, and it
reads line by line — so every bullet stays on one line, however long, and makes
sense without its heading. Only the opening paragraph is prose.

## v0.5.5

A settings switch that showed the wrong state, and could turn a setting off when
you clicked it to turn it on. If your update checks stopped without you meaning
to, this is why. Settings got a tidy-up around it: the right app icon, and no
more focus boxes drawn around things you never touched.

### Settings

- **"Automatically check for updates" now shows what it is actually set to.** The switch came up off however it was stored, and because clicking it read the stored value rather than the one on screen, a click meant to enable it turned it off instead. If your update checks stopped on their own, open Settings → About and set it once more.
- **Every switch and segmented control now paints itself from what is stored**, so no setting can come up showing a state it is not in.
- **A switch also tells a screen reader whether it is on** before it has been touched.
- **Settings no longer draws a focus box around General** the moment it opens, or around any other control it puts focus on. Keyboard focus is shown the way the rest of the app shows it — the control takes the emphasis it already has, rather than a ring around it.
- **About shows the app's real icon.** It was still drawing the mark Jotter had before v0.5.2 replaced it.

### Telling one build from another

- **A build that is not the released app now says so** — a DEV badge in the status bar, "— DEV" in the window title, and "(dev build)" beside the version in About. Development builds share a drafts folder with the installed app, so knowing which one is on screen is worth a glance.

## v0.5.3

A fix for Save As, which could show you a path and write nothing at all, and a
rule the app now keeps: if a save does not reach disk, it says so.

### Save As

- **Save As writes the file it names.** A note whose autosave had already run got a path in the sidebar and in the title bar with no file behind it, and the first sign was Reveal in Finder saying it could not find it. Saving in the moment before the autosave ran still worked, which is why the fault came and went.
- **Saving onto a file that already exists no longer reports a conflict** that was invented from the previous file's timestamp.
- **Saving onto a file another note already has open leaves one note on that file**, rather than two that each re-read the other's text and each write over it.

### When a save cannot reach disk

- **A save that fails now says so**, naming the note and offering a way out: Save As for the note in the editor, Retry for one in the background. An unwritable folder, a locked file or a full disk used to leave the path on screen, nothing on disk, and nothing said.
- **The message stands until a save gets through**, and is not repeated for every autosave behind it.

### Messages you can tell apart

- **A message now carries the colour of what it reports** — red for a failure, amber for a decision waiting on you, green for something that worked. Every message used to be the same white card, so a failure looked exactly like a confirmation and was easy to walk past.
- **A failure also interrupts a screen reader** instead of waiting its turn politely.

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
