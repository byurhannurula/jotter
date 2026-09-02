// @vitest-environment happy-dom
//
// Random sessions with an oracle. fast-check generates sequences of the things
// a person does — open, close, cycle, reopen, type, delete, undo, and pauses of
// different lengths — runs each one against the real main.js, and after every
// step compares the app to a small model of what should be true. A failing run
// is shrunk to the shortest sequence that still fails.
//
// The rules checked after every step are the ones that break when tab and
// editor wiring goes wrong: the editor shows the active draft's text, the tabs
// are what the model says they are, the sidebar lists exactly the drafts with
// content, the store never lags a draft that is not mid-autosave, and no save
// ever wrote text the model never had.
//
// JOTTER_FUZZ_RUNS=200 pnpm test -- app.random   for a deep run.

import { describe, it, expect, afterEach } from "vitest";
import fc from "fast-check";
import { clearMocks } from "@tauri-apps/api/mocks";
import { boot, sleep, AUTOSAVE_MS } from "./app-harness.js";

const RUNS = Number(process.env.JOTTER_FUZZ_RUNS) || 8;

let bootCount = 0;

/** Two drafts with ids no other boot in this process will reuse. */
function seedDrafts() {
  bootCount += 1;
  const mk = (id, content, u) => ({
    id: `d${bootCount}-${id}`,
    title: "",
    content,
    file_path: null,
    created_at: 1,
    updated_at: u,
    pinned: false,
    cloud: false,
  });
  return [mk("a", "alpha text", 2), mk("b", "bravo text", 1)];
}

/** What the app should look like, from the test's point of view. */
class Model {
  constructor(drafts) {
    this.content = new Map(drafts.map((d) => [d.id, d.content]));
    this.open = []; // tab ids, left to right
    this.active = null;
    this.closed = []; // reopen stack
    this.deleted = new Set();
    this.dirty = null; // id with an autosave pending
    this.undoable = []; // deleted ids whose Undo toast may still be up, oldest first
  }
  /** Ids the sidebar should show: content, and not deleted. Sorted for stable picking. */
  sidebar() {
    return [...this.content.keys()]
      .filter((id) => this.content.get(id) !== "" && !this.deleted.has(id))
      .sort();
  }
  /** A brand-new blank became current: learn its id from the app. */
  adoptBlank(id) {
    if (!this.content.has(id)) this.content.set(id, "");
    if (!this.open.includes(id)) this.open.push(id);
    this.active = id;
  }
}

/** The oracle. Runs after every command. `before` is the model as it was
 *  before the command, for judging the saves the command produced. */
function check(model, real, before, savesBefore) {
  const active = real.activeTabId();
  expect(active, "active tab").toBe(model.active);
  expect(real.editor.value, `editor text for ${active}`).toBe(
    model.content.get(model.active) ?? "",
  );
  expect(real.tabIds(), "open tabs").toEqual(model.open);
  expect([...real.sidebarIds()].sort(), "sidebar").toEqual(model.sidebar());

  for (const [id, text] of model.content) {
    if (text === "" || model.deleted.has(id) || id === model.dirty) continue;
    expect(real.host.store.get(id)?.content, `store copy of ${id}`).toBe(text);
  }

  // Every save the command caused wrote text the model had for that id, either
  // before or after the command. Anything else is a save from the wrong tab.
  for (const s of real.host.saves.slice(savesBefore)) {
    if (!model.content.has(s.id) && !before.has(s.id)) continue; // a stray timer from an earlier boot
    const allowed = [before.get(s.id), model.content.get(s.id)];
    expect(allowed, `save of ${s.id} wrote "${s.content}"`).toContain(s.content);
    expect(s.content, "a save must never write a blank over a note").not.toBe("");
  }
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
      const before = new Map(m.content);
      const savesBefore = real.host.saves.length;
      await run(m, real, this.arg);
      check(m, real, before, savesBefore);
    }
    toString() {
      return this.arg === undefined ? name : `${name}(${JSON.stringify(this.arg)})`;
    }
  };
}

const ClickDraft = cmd("ClickDraft", {
  check: (m) => m.sidebar().length > 0,
  run: async (m, real, i) => {
    const ids = m.sidebar();
    const id = ids[i % ids.length];
    await real.clickDraft(id);
    if (id !== m.active) m.dirty = null; // the switch flushed
    if (!m.open.includes(id)) m.open.push(id);
    m.active = id;
  },
});

const NewTab = cmd("NewTab", {
  run: async (m, real) => {
    await real.menu("new");
    m.dirty = null;
    m.adoptBlank(real.activeTabId());
  },
});

const CloseTab = cmd("CloseTab", {
  run: async (m, real) => {
    const id = m.active;
    const blank = m.content.get(id) === "";
    if (m.open.length === 1 && blank) {
      await real.menu("close_tab");
      return; // nothing to close
    }
    await real.menu("close_tab");
    m.dirty = null;
    const idx = m.open.indexOf(id);
    m.open.splice(idx, 1);
    if (blank) {
      m.content.delete(id); // pruned from the store
    } else {
      m.closed.push(id);
    }
    if (m.open.length === 0) m.adoptBlank(real.activeTabId());
    else m.active = m.open[Math.min(idx, m.open.length - 1)];
  },
});

const Cycle = cmd("Cycle", {
  run: async (m, real, dir) => {
    await real.menu(dir > 0 ? "next_tab" : "prev_tab");
    if (m.open.length < 2) return;
    const n = m.open.length;
    const i = m.open.indexOf(m.active);
    m.active = m.open[(i + dir + n) % n];
    m.dirty = null;
  },
});

const Reopen = cmd("Reopen", {
  run: async (m, real) => {
    await real.menu("reopen_tab");
    while (m.closed.length) {
      const id = m.closed.pop();
      if (m.content.has(id) && !m.deleted.has(id)) {
        if (!m.open.includes(id)) m.open.push(id);
        if (id !== m.active) m.dirty = null; // activating the active tab is a no-op, no flush
        m.active = id;
        return;
      }
    }
  },
});

const Type = cmd("Type", {
  run: async (m, real, text) => {
    await real.type(text);
    m.content.set(m.active, text);
    m.dirty = m.active;
  },
});

const Wait = cmd("Wait", {
  run: async (m, real, ms) => {
    await sleep(ms);
    if (ms > AUTOSAVE_MS) m.dirty = null;
  },
});

const Delete = cmd("Delete", {
  check: (m) => m.content.get(m.active) !== "" && !m.deleted.has(m.active),
  run: async (m, real) => {
    const id = m.active;
    await real.contextMenu(id, "Delete");
    m.deleted.add(id);
    m.undoable.push(id);
    m.open = m.open.filter((t) => t !== id);
    m.closed = m.closed.filter((t) => t !== id);
    m.dirty = null;
    if (m.open.length === 0) m.adoptBlank(real.activeTabId());
    else m.active = m.open[m.open.length - 1];
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
  fc.constant(new Delete()),
  fc.constant(new Undo()),
];

let real = null;
afterEach(() => {
  clearMocks();
  real = null;
});

describe("random sessions", () => {
  it(
    "keep the editor, tabs, sidebar and store in agreement after every step",
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.commands(commands, { size: "medium" }), async (cmds) => {
          const setup = async () => {
            const drafts = seedDrafts();
            real = await boot({ drafts });
            const model = new Model(drafts);
            model.adoptBlank(real.activeTabId());
            return { model, real };
          };
          await fc.asyncModelRun(setup, cmds);
        }),
        { numRuns: RUNS, verbose: true },
      );
      // A session takes up to ~1.5 s (boot plus waits); scale the limit with the count.
    },
    30_000 + RUNS * 2_000,
  );
});
