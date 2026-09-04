// @vitest-environment happy-dom
//
// Random sessions with an oracle. fast-check generates sequences of the things
// a person does — open, close, cycle, reopen, type, rename, pin, delete, undo,
// an outside edit to a file-backed note, a sync landing, and pauses of
// different lengths — runs each one against the real main.js, and after every
// step compares the app to a small model of what should be true. A failing run
// is shrunk to the shortest sequence that still fails.
//
// The rules checked after every step are the ones that break when tab, editor
// and store wiring goes wrong: the editor shows the active draft's text, the
// tabs and the sidebar (order included) are what the model says, the store or
// the file on disk never lags a draft that is not mid-autosave, and no save
// ever wrote text the model never had.
//
// JOTTER_FUZZ_RUNS=200 pnpm test -- app.random   for a deep run.
// JOTTER_FUZZ_SEED=<n> JOTTER_FUZZ_PATH=<replayPath>   to replay one reported failure.

import { describe, it, expect, afterEach } from "vitest";
import fc from "fast-check";
import { clearMocks } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { findMatches } from "./lib/text.js";
import { boot, sleep, settle, AUTOSAVE_MS } from "./app-harness.js";

const RUNS = Number(process.env.JOTTER_FUZZ_RUNS) || 6;

let bootCount = 0;
/** When the last Type happened, in any session. An autosave timer from the
 *  previous session would otherwise fire into the next one's store. */
let lastEditAt = 0;

/** Two in-app drafts and one file-backed draft, with ids no other boot in this
 *  process will reuse (a stray timer from an earlier boot must not find them). */
function seedDrafts() {
  bootCount += 1;
  const mk = (id, content, u, file_path = null) => ({
    id: `d${bootCount}-${id}`,
    title: "",
    content,
    file_path,
    created_at: 1,
    updated_at: u,
    pinned: false,
    cloud: false,
    file_mtime: file_path ? 1000 : null,
  });
  return {
    drafts: [
      mk("a", "alpha text", 3),
      mk("b", "bravo text", 2),
      mk("f", "file text", 1, `/notes/${bootCount}/f.txt`),
    ],
    files: {
      [`/notes/${bootCount}/f.txt`]: "file text",
      [`/notes/${bootCount}/extra.txt`]: "a file nobody opened yet", // for OpenFile
    },
  };
}

/** What the app should look like, from the test's point of view. */
class Model {
  constructor(drafts, files = {}) {
    this.paths = Object.keys(files); // files on disk the open dialog can pick
    this.content = new Map(drafts.map((d) => [d.id, d.content]));
    this.title = new Map();
    this.file = new Map(drafts.filter((d) => d.file_path).map((d) => [d.id, d.file_path]));
    this.pinned = new Set();
    this.lastEdit = new Map(drafts.map((d) => [d.id, d.updated_at]));
    this.clock = 100; // later than any seeded updated_at
    this.open = []; // tab ids, left to right
    this.active = null;
    this.closed = []; // reopen stack
    this.deleted = new Set();
    this.undoable = []; // deleted ids whose Undo toast may still be up, oldest first
    this.dirty = null; // id with an autosave pending
    this.conflict = null; // file draft whose save was refused; toast is up
    this.stale = new Set(); // file drafts whose memory copy is behind the file
    this.preview = new Set(); // tabs showing the markdown preview instead of the editor
    this.focus = false; // focus mode on
    // The mtime the app believes each file has: set on read and on a
    // successful write. A save compares it with the real one.
    this.knownMtime = new Map(drafts.filter((d) => d.file_path).map((d) => [d.id, d.file_mtime]));
  }
  touch(id) {
    this.clock += 1;
    this.lastEdit.set(id, this.clock);
  }
  /** A draft the sidebar shows: text (whitespace is not text), a name, or a
   *  file behind it. Mirrors isEmpty() in lib/text.js. */
  saved(id) {
    return this.content.get(id).trim() !== "" || !!this.title.get(id) || this.file.has(id);
  }
  /** Sidebar rows in order: pinned first, then most recently edited first. */
  sidebar() {
    return [...this.content.keys()]
      .filter((id) => this.saved(id) && !this.deleted.has(id))
      .sort((x, y) => {
        const px = this.pinned.has(x) ? 1 : 0;
        const py = this.pinned.has(y) ? 1 : 0;
        if (px !== py) return py - px;
        return this.lastEdit.get(y) - this.lastEdit.get(x);
      });
  }
  /** A brand-new blank became current: learn its id from the app. */
  adoptBlank(id) {
    if (!this.content.has(id)) this.content.set(id, "");
    if (!this.lastEdit.has(id)) this.lastEdit.set(id, 0);
    if (!this.open.includes(id)) this.open.push(id);
    this.active = id;
  }
  /** The app re-read a file draft from disk. */
  reread(id, real) {
    if (!this.file.has(id)) return;
    this.content.set(id, real.host.disk.get(this.file.get(id)));
    this.knownMtime.set(id, real.host.mtimes.get(this.file.get(id)));
    if (this.dirty === id) this.dirty = null;
    if (this.conflict === id) this.conflict = null;
    this.stale.delete(id);
  }
}

/** The oracle. Runs after every command. `before` is the model as it was
 *  before the command, for judging the saves the command produced. */
function check(model, real, before, savesBefore) {
  const active = real.activeTabId();
  expect(active, "active tab").toBe(model.active);
  if (real.editor.value !== (model.content.get(model.active) ?? "")) {
    // Print what the host saw, so a timing-dependent failure can be read.
    console.log("ORACLE editor mismatch", {
      active,
      dirty: model.dirty,
      now: Date.now(),
      lastEditAt,
      saves: real.host.saves.slice(-6),
      store: real.host.store.get(active),
      events: real.host.events.slice(-8),
    });
  }
  expect(real.editor.value, `editor text for ${active}`).toBe(
    model.content.get(model.active) ?? "",
  );
  expect(real.tabIds(), "open tabs").toEqual(model.open);
  expect(real.sidebarIds(), "sidebar order").toEqual(model.sidebar());

  for (const [id, text] of model.content) {
    // A draft mid-conflict keeps its refused edit in memory; nothing on disk
    // or in the store is expected to match until the toast is answered.
    if (model.deleted.has(id) || id === model.dirty || id === model.conflict) continue;
    if (model.stale.has(id)) continue;
    if (model.file.has(id)) {
      // A file draft's truth is the file. The store entry may lag after a
      // re-read, which only touches memory.
      expect(real.host.disk.get(model.file.get(id)), `disk copy of ${id}`).toBe(text);
    } else if (model.saved(id)) {
      expect(real.host.store.get(id)?.content, `store copy of ${id}`).toBe(text);
    }
  }

  // Every save the command caused wrote text the model had for that id, either
  // before or after the command. Anything else is a save from the wrong tab.
  for (const s of real.host.saves.slice(savesBefore)) {
    if (!model.content.has(s.id) && !before.has(s.id)) continue; // a stray timer from an earlier boot
    const allowed = [before.get(s.id), model.content.get(s.id)];
    expect(allowed, `save of ${s.id} wrote "${s.content}"`).toContain(s.content);
    // A named note may be emptied on purpose and is kept; an unnamed in-app
    // draft with nothing in it is never written.
    if (!model.file.has(s.id) && !model.title.get(s.id)) {
      expect(s.content.trim(), "a save must never write a blank over a note").not.toBe("");
    }
  }

  const toast = [...document.querySelectorAll("#toast-host .toast:not(.out) .toast-action")].some(
    (b) => b.textContent === "Reload",
  );
  expect(toast, "conflict toast").toBe(model.conflict !== null);
}

/** Wrap a command so its run() records the before-state and checks after. */
function cmd(name, { check: pre = () => true, run }) {
  return class {
    constructor(arg) {
      this.arg = arg;
    }
    check(m) {
      return pre(m, this.arg);
    }
    async run(m, real) {
      // The autosave timer runs on wall-clock time. A slow command (a loaded
      // machine, a GC pause) can let it fire mid-sequence, so the model checks
      // the clock before and after every command rather than only in Wait.
      autosaveMayHaveFired(m, real);
      const before = new Map(m.content);
      const savesBefore = real.host.saves.length;
      // What the files' mtimes were when the command started: a write the
      // command itself causes bumps them, and the app's conflict check ran
      // against the values before that write.
      m.mtimesBefore = new Map(real.host.mtimes);
      await run(m, real, this.arg);
      autosaveMayHaveFired(m, real);
      check(m, real, before, savesBefore);
    }
    toString() {
      return this.arg === undefined ? name : `${name}(${JSON.stringify(this.arg)})`;
    }
  };
}

const pick = (m, i) => {
  const ids = m.sidebar();
  return ids[i % ids.length];
};

/** If the autosave delay has passed since the last keystroke, the pending
 *  edit has been written (or refused): account for it. */
function autosaveMayHaveFired(m, real) {
  if (m.dirty !== null && Date.now() - lastEditAt > AUTOSAVE_MS + 40) flushed(m, real);
}

/** The app tried to write the pending edit. For a file draft whose file moved
 *  on underneath, the write is refused and the conflict toast goes up; the
 *  edit stays pending. Otherwise the store (and file) now hold it. */
function flushed(m, real) {
  const id = m.dirty;
  if (id === null) return;
  const path = m.file.get(id);
  if (path && m.mtimesBefore.get(path) !== m.knownMtime.get(id)) {
    m.conflict = id;
    return;
  }
  m.dirty = null;
  wrote(m, real, id);
}

/** The app wrote a file draft: it now knows the file's new mtime. Renames and
 *  pins write too, whether or not anything was typed. */
function wrote(m, real, id) {
  const path = m.file.get(id);
  if (path) m.knownMtime.set(id, real.host.mtimes.get(path));
}

/** Becoming current through activate(): flushes the old tab, re-reads a file. */
function switchTo(m, real, id) {
  if (id === m.active) return; // activating the active tab is a no-op
  flushed(m, real);
  m.reread(id, real);
  m.active = id;
}

const ClickDraft = cmd("ClickDraft", {
  check: (m) => m.sidebar().length > 0,
  run: async (m, real, i) => {
    const id = pick(m, i);
    await real.clickDraft(id);
    if (!m.open.includes(id)) m.open.push(id);
    switchTo(m, real, id);
  },
});

const NewTab = cmd("NewTab", {
  run: async (m, real) => {
    await real.menu("new");
    flushed(m, real);
    m.adoptBlank(real.activeTabId());
  },
});

const CloseTab = cmd("CloseTab", {
  run: async (m, real) => {
    const id = m.active;
    const blank = !m.saved(id);
    if (m.open.length === 1 && blank) {
      await real.menu("close_tab");
      return; // nothing to close
    }
    await real.menu("close_tab");
    flushed(m, real);
    const idx = m.open.indexOf(id);
    m.open.splice(idx, 1);
    if (blank) {
      m.content.delete(id); // pruned from the store
    } else {
      m.closed.push(id);
      m.preview.delete(id); // a closed tab forgets its preview
    }
    if (m.open.length === 0) m.adoptBlank(real.activeTabId());
    else switchTo(m, real, m.open[Math.min(idx, m.open.length - 1)]);
  },
});

const Cycle = cmd("Cycle", {
  run: async (m, real, dir) => {
    await real.menu(dir > 0 ? "next_tab" : "prev_tab");
    if (m.open.length < 2) return;
    const n = m.open.length;
    const i = m.open.indexOf(m.active);
    switchTo(m, real, m.open[(i + dir + n) % n]);
  },
});

const Reopen = cmd("Reopen", {
  run: async (m, real) => {
    await real.menu("reopen_tab");
    while (m.closed.length) {
      const id = m.closed.pop();
      if (m.content.has(id) && !m.deleted.has(id)) {
        if (!m.open.includes(id)) m.open.push(id);
        switchTo(m, real, id);
        return;
      }
    }
  },
});

const Type = cmd("Type", {
  check: (m) => !m.preview.has(m.active), // the editor is hidden behind the preview
  run: async (m, real, text) => {
    await real.type(text);
    lastEditAt = Date.now();
    m.content.set(m.active, text);
    m.touch(m.active);
    m.dirty = m.active;
    m.stale.delete(m.active); // typed over it: a real conflict now, judged at the next save
  },
});

const Wait = cmd("Wait", {
  run: async (m, real, ms) => {
    await sleep(ms);
    await settle(); // a long enough wait lets the autosave fire; the wrapper accounts for it
  },
});

const fresh = (m, id) =>
  !m.stale.has(id) && id !== m.conflict && (m.dirty !== id || !m.file.has(id));

/** Rename and pin write the entry only, unless the store has never seen the
 *  draft, in which case the app falls back to a full save. */
function metaWritten(m, real, id) {
  if (!real.host.store.has(id) && m.dirty === id) flushed(m, real);
}

const Rename = cmd("Rename", {
  check: (m) => m.sidebar().length > 0,
  run: async (m, real, [i, name]) => {
    const id = pick(m, i);
    await real.contextMenu(id, "Rename…");
    const input = document.getElementById("prompt-input");
    input.value = name;
    document.getElementById("prompt-ok").click();
    await settle();
    if (!name.trim()) return; // the prompt treats a blank name as cancel
    const stored = real.host.store.has(id);
    m.title.set(id, name.trim());
    m.touch(id);
    if (!stored) metaWritten(m, real, id);
  },
});

const Pin = cmd("Pin", {
  check: (m) => m.sidebar().length > 0,
  run: async (m, real, i) => {
    const id = pick(m, i);
    const stored = real.host.store.has(id);
    await real.contextMenu(id, m.pinned.has(id) ? "Unpin" : "Pin");
    if (m.pinned.has(id)) m.pinned.delete(id);
    else m.pinned.add(id);
    m.touch(id);
    if (!stored) metaWritten(m, real, id);
  },
});

const Delete = cmd("Delete", {
  check: (m) => m.saved(m.active) && !m.deleted.has(m.active) && fresh(m, m.active),
  run: async (m, real) => {
    const id = m.active;
    await real.contextMenu(id, "Delete");
    m.deleted.add(id);
    m.preview.delete(id);
    m.undoable.push(id);
    m.open = m.open.filter((t) => t !== id);
    m.closed = m.closed.filter((t) => t !== id);
    if (m.dirty === id) m.dirty = null;
    if (m.open.length === 0) m.adoptBlank(real.activeTabId());
    else switchTo(m, real, m.open[m.open.length - 1]);
  },
});

const Undo = cmd("Undo", {
  check: (m) => m.undoable.length > 0,
  run: async (m, real) => {
    // The newest toast belongs to the newest delete. If it has timed out, so
    // have all the older ones.
    const id = m.undoable.pop();
    const clicked = await real.clickToast("Undo");
    if (clicked) m.deleted.delete(id);
    else m.undoable = [];
  },
});

/** Another program writes the file behind the file-backed draft. */
const ExternalEdit = cmd("ExternalEdit", {
  check: (m) => [...m.file.keys()].some((id) => !m.deleted.has(id)) && m.conflict === null,
  run: async (m, real, text) => {
    const id = [...m.file.keys()].find((x) => !m.deleted.has(x));
    real.host.editOutside(m.file.get(id), text);
    // Nothing in the app moves until it next reads that file (activate) or
    // writes it (a save after a real edit, which then conflicts). Until then
    // the memory copy is behind the file on purpose, and nothing is written.
    if (m.dirty !== id) m.stale.add(id);
  },
});

const Reload = cmd("Reload", {
  check: (m) => m.conflict !== null,
  run: async (m, real) => {
    const id = m.conflict;
    await real.clickToast("Reload");
    m.reread(id, real);
  },
});

const KeepMine = cmd("KeepMine", {
  check: (m) => m.conflict !== null,
  run: async (m, real) => {
    const id = m.conflict;
    await real.clickToast("Keep mine");
    await settle();
    m.conflict = null;
    m.dirty = null; // written regardless of the mtime
    wrote(m, real, id);
  },
});

/** A sync lands a newer copy of one draft in the store, then the app is told. */
const SyncChanged = cmd("SyncChanged", {
  check: (m) =>
    [...m.content.keys()].some(
      (id) => !m.deleted.has(id) && !m.file.has(id) && m.content.get(id) !== "",
    ),
  run: async (m, real, i) => {
    const ids = [...m.content.keys()].filter(
      (id) => !m.deleted.has(id) && !m.file.has(id) && m.content.get(id) !== "",
    );
    const id = ids[i % ids.length];
    const entry = real.host.store.get(id);
    if (!entry) return; // not yet autosaved: nothing for a sync to update
    const text = `synced ${m.clock}`;
    real.host.events.push({ at: Date.now(), what: "sync store.set", id, text });
    real.host.store.set(id, { ...entry, content: text, updated_at: Date.now() + 1 });
    await emit("sync:changed", null);
    await settle();
    await settle();
    if (m.dirty === id) return; // typed text waiting for autosave wins over the pull
    m.content.set(id, text);
    m.touch(id);
  },
});

/** Quick Open: pick the i-th row. Its order is the sidebar's. */
const Switcher = cmd("Switcher", {
  run: async (m, real, i) => {
    await real.menu("switcher");
    const rows = m.sidebar();
    if (rows.length === 0) return; // "No drafts to open yet" toast, nothing opens
    const input = document.getElementById("switcher-input");
    const id = rows[i % rows.length];
    for (let k = 0; k < i % rows.length; k += 1) {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    }
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle();
    if (!m.open.includes(id)) m.open.push(id);
    switchTo(m, real, id);
  },
});

/** Find bar, Replace All, close: an edit made without a keystroke in the
 *  editor, so it must still mark the draft unsaved and autosave. */
const ReplaceAll = cmd("ReplaceAll", {
  check: (m) => !m.preview.has(m.active),
  run: async (m, real, [from, to]) => {
    await real.menu("find");
    const findInput = document.getElementById("find-input");
    findInput.value = from;
    findInput.dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("replace-input").value = to;
    document.getElementById("replace-all").click();
    document.getElementById("find-close").click();
    await settle();
    const text = m.content.get(m.active);
    const hits = findMatches(text, from);
    if (!hits.length) return;
    let out = text;
    for (let k = hits.length - 1; k >= 0; k -= 1) {
      const [a, b] = hits[k];
      out = out.slice(0, a) + to + out.slice(b);
    }
    lastEditAt = Date.now();
    m.content.set(m.active, out);
    m.touch(m.active);
    m.dirty = m.active;
    m.stale.delete(m.active);
  },
});

/** Markdown preview on the active tab. Typing is impossible while it is on. */
const Preview = cmd("Preview", {
  run: async (m, real) => {
    await real.menu("toggle_preview");
    if (m.preview.has(m.active)) m.preview.delete(m.active);
    else m.preview.add(m.active);
    const editor = document.getElementById("editor");
    expect(editor.hidden).toBe(m.preview.has(m.active));
  },
});

/** Focus mode, through the menu. The toggle is debounced at 400ms, so the
 *  command waits that out before the next one can toggle again. The wait is
 *  well past the autosave's 400ms too, so the wrapper can tell a save that
 *  fired during it from one that did not (its margin is 40ms). */
const FocusMode = cmd("FocusMode", {
  run: async (m) => {
    await real.menu("focus_mode");
    m.focus = !m.focus;
    await sleep(520);
    await settle();
    expect(document.body.classList.contains("focus-mode")).toBe(m.focus);
  },
});

/** File > Open, with the dialog answering a path from the seed. An already
 *  open file gets its tab focused; a blank scratch tab is reused in place;
 *  otherwise a new file draft opens beside the others and is registered in
 *  the store without the file being rewritten. */
const OpenFile = cmd("OpenFile", {
  // Kept out of half-deleted and conflicted states, where the app's "already
  // open" lookup and the model would need a second set of rules.
  check: (m) => m.undoable.length === 0 && m.conflict === null,
  run: async (m, real, i) => {
    const path = m.paths[i % m.paths.length];
    const scratch = m.saved(m.active) ? null : m.active;
    real.host.dialog.next = path;
    await real.menu("open");
    flushed(m, real);
    const existing = [...m.file.entries()].find(([id, p]) => p === path && !m.deleted.has(id))?.[0];
    if (existing !== undefined) {
      if (scratch && scratch !== existing) m.open = m.open.filter((t) => t !== scratch);
      if (!m.open.includes(existing)) m.open.push(existing);
      switchTo(m, real, existing);
      return;
    }
    const id = scratch ?? real.activeTabId();
    m.content.set(id, real.host.disk.get(path));
    m.file.set(id, path);
    m.knownMtime.set(id, real.host.mtimes.get(path));
    m.touch(id);
    if (!m.open.includes(id)) m.open.push(id);
    m.active = id;
  },
});

/** Flip one toggle setting mid-session. None of them may touch the text. */
const ToggleSetting = cmd("ToggleSetting", {
  run: async (m, real, name) => {
    document.getElementById(`set-${name}`).click();
    await settle();
  },
});

const commands = [
  fc.nat(5).map((i) => new ClickDraft(i)),
  fc.constant(new NewTab()),
  fc.constant(new CloseTab()),
  fc.constantFrom(1, -1).map((d) => new Cycle(d)),
  fc.constant(new Reopen()),
  fc
    .constantFrom(
      "",
      "x",
      "alpha text",
      "two\nlines",
      "  spaces  ",
      "a much longer note\n\nwith a gap",
    )
    .map((t) => new Type(t)),
  fc.constantFrom(0, 16, 450).map((ms) => new Wait(ms)),
  fc.tuple(fc.nat(5), fc.constantFrom("Shopping", "  ", "notes", "")).map((a) => new Rename(a)),
  fc.nat(5).map((i) => new Pin(i)),
  fc.constant(new Delete()),
  fc.constant(new Undo()),
  fc.constantFrom("edited elsewhere", "another outside write").map((t) => new ExternalEdit(t)),
  fc.constant(new Reload()),
  fc.constant(new KeepMine()),
  fc.nat(5).map((i) => new SyncChanged(i)),
  fc.nat(5).map((i) => new Switcher(i)),
  fc
    .tuple(fc.constantFrom("x", "text", "lines", "note", "  "), fc.constantFrom("", "y", "TEXT"))
    .map((a) => new ReplaceAll(a)),
  fc.constant(new Preview()),
  fc.constant(new FocusMode()),
  fc.nat(3).map((i) => new OpenFile(i)),
  fc
    .constantFrom("statusbar", "sidebarBtn", "previewBtn", "focusFull")
    .map((n) => new ToggleSetting(n)),
];

let real = null;
afterEach(() => {
  clearMocks();
  real = null;
});

describe("random sessions", () => {
  it(
    "keep the editor, tabs, sidebar, store and disk in agreement after every step",
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.commands(commands, { size: "medium" }), async (cmds) => {
          const setup = async () => {
            const drain = AUTOSAVE_MS + 80 - (Date.now() - lastEditAt);
            if (drain > 0) await sleep(drain); // let the previous session's autosave land
            const { drafts, files } = seedDrafts();
            real = await boot({ drafts, files });
            const model = new Model(drafts, files);
            model.adoptBlank(real.activeTabId());
            return { model, real };
          };
          await fc.asyncModelRun(setup, cmds);
        }),
        { numRuns: RUNS, verbose: true },
      );
    },
    // A session takes up to ~3 s (boot, waits, the autosave drain); scale the limit with the count.
    30_000 + RUNS * 8_000,
  );
});
