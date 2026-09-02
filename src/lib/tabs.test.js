import { describe, it, expect } from "vitest";
import {
  activateBlank,
  closeTab,
  cycleTab,
  dropScratch,
  newTab,
  openInTab,
  removeDraftFromView,
  reopenClosedTab,
} from "./tabs.js";
import { isEmpty } from "./text.js";

/** A draft with content unless `content` is given as "". */
const draft = (id, content = `text of ${id}`, extra = {}) => ({
  id,
  title: "",
  content,
  file_path: null,
  created_at: 1,
  updated_at: 1,
  pinned: false,
  ...extra,
});

let blankCount = 0;

/** Build a world: a drafts Map plus a blank-maker with predictable ids. */
function world(entries = []) {
  const drafts = new Map(entries.map((d) => [d.id, d]));
  blankCount = 0;
  return {
    drafts,
    makeBlank: () => draft(`blank-${++blankCount}`, ""),
  };
}

const state = (openTabs, currentId, closedStack = []) => ({
  openTabs,
  currentId,
  closedStack,
});

const types = (effects) => effects.map((e) => e.type);

/**
 * Invariants that must hold after every transition. Asserted at the end of each
 * case, because a tab bug usually shows up as one of these rather than as a
 * wrong return value.
 */
function check(state, deps) {
  expect(state.openTabs.length).toBeGreaterThanOrEqual(1);
  expect(state.openTabs).toContain(state.currentId);
  expect(new Set(state.openTabs).size).toBe(state.openTabs.length);
  for (const id of state.openTabs) expect(deps.drafts.has(id)).toBe(true);
  for (const id of state.closedStack) {
    const d = deps.drafts.get(id);
    if (d) expect(isEmpty(d)).toBe(false);
  }
}

describe("closeTab", () => {
  it("picks the tab that slid into the slot", () => {
    const w = world([draft("a"), draft("b"), draft("c")]);
    const r = closeTab(state(["a", "b", "c"], "b"), w, "b");
    expect(r.state.openTabs).toEqual(["a", "c"]);
    expect(r.state.currentId).toBe("c");
    check(r.state, w);
  });

  it("picks the one to the left when closing the last tab", () => {
    const w = world([draft("a"), draft("b"), draft("c")]);
    const r = closeTab(state(["a", "b", "c"], "c"), w, "c");
    expect(r.state.currentId).toBe("b");
    check(r.state, w);
  });

  it("leaves the current tab alone when closing another", () => {
    const w = world([draft("a"), draft("b"), draft("c")]);
    const r = closeTab(state(["a", "b", "c"], "a"), w, "c");
    expect(r.state.openTabs).toEqual(["a", "b"]);
    expect(r.state.currentId).toBe("a");
    expect(types(r.effects)).not.toContain("flush");
    check(r.state, w);
  });

  it("flushes pending edits only when the closing tab is current", () => {
    const w = world([draft("a"), draft("b")]);
    expect(types(closeTab(state(["a", "b"], "a"), w, "a").effects)).toContain("flush");
  });

  it("spawns a blank when the last tab is closed", () => {
    const w = world([draft("a")]);
    const r = closeTab(state(["a"], "a"), w, "a");
    expect(r.state.openTabs).toEqual(["blank-1"]);
    expect(isEmpty(w.drafts.get("blank-1"))).toBe(true);
    check(r.state, w);
  });

  it("does nothing when the only tab is already blank", () => {
    const w = world([draft("a", "")]);
    const before = state(["a"], "a");
    const r = closeTab(before, w, "a");
    expect(r.state).toBe(before);
    expect(r.effects).toEqual([]);
  });

  it("remembers a draft with content so it can be reopened", () => {
    const w = world([draft("a"), draft("b")]);
    const r = closeTab(state(["a", "b"], "a"), w, "a");
    expect(r.state.closedStack).toEqual(["a"]);
    check(r.state, w);
  });

  it("prunes a blank instead of remembering it", () => {
    const w = world([draft("a", ""), draft("b")]);
    const r = closeTab(state(["a", "b"], "a"), w, "a");
    expect(r.state.closedStack).toEqual([]);
    expect(types(r.effects)).toContain("delete");
    expect(w.drafts.has("a")).toBe(false);
    check(r.state, w);
  });

  it("ignores an id that is not open", () => {
    const w = world([draft("a")]);
    const before = state(["a"], "a");
    expect(closeTab(before, w, "zzz").state).toBe(before);
  });
});

describe("cycleTab", () => {
  it("wraps forward past the end", () => {
    const w = world([draft("a"), draft("b"), draft("c")]);
    const r = cycleTab(state(["a", "b", "c"], "c"), 1);
    expect(r.state.currentId).toBe("a");
    check(r.state, w);
  });

  it("wraps backward past the start", () => {
    const w = world([draft("a"), draft("b"), draft("c")]);
    const r = cycleTab(state(["a", "b", "c"], "a"), -1);
    expect(r.state.currentId).toBe("c");
    check(r.state, w);
  });

  it("does nothing with a single tab", () => {
    const before = state(["a"], "a");
    expect(cycleTab(before, 1).state).toBe(before);
  });
});

describe("reopenClosedTab", () => {
  it("pops from the top and stops at the first draft still there", () => {
    const w = world([draft("open"), draft("y")]);
    const r = reopenClosedTab(state(["open"], "open", ["x", "y"]), w);
    expect(r.state.currentId).toBe("y");
    // "x" is never reached, so it stays for a later press — it will be skipped
    // then if it is still gone.
    expect(r.state.closedStack).toEqual(["x"]);
    check(r.state, w);
  });

  it("discards dead ids it passes on the way down", () => {
    const w = world([draft("open"), draft("y")]);
    const r = reopenClosedTab(state(["open"], "open", ["y", "x"]), w);
    expect(r.state.currentId).toBe("y");
    expect(r.state.closedStack).toEqual([]);
    check(r.state, w);
  });

  it("gives up quietly when nothing on the stack still exists", () => {
    const w = world([draft("open")]);
    const r = reopenClosedTab(state(["open"], "open", ["x", "y"]), w);
    expect(r.state.currentId).toBe("open");
    expect(r.state.closedStack).toEqual([]);
    expect(r.effects).toEqual([]);
    check(r.state, w);
  });

  it("does nothing with an empty stack", () => {
    const w = world([draft("a")]);
    const r = reopenClosedTab(state(["a"], "a", []), w);
    expect(r.state.openTabs).toEqual(["a"]);
    expect(r.effects).toEqual([]);
  });

  it("does not duplicate a tab that is already open", () => {
    const w = world([draft("a"), draft("b")]);
    const r = reopenClosedTab(state(["a", "b"], "a", ["b"]), w);
    expect(r.state.openTabs).toEqual(["a", "b"]);
    expect(r.state.currentId).toBe("b");
    check(r.state, w);
  });
});

describe("openInTab", () => {
  it("appends an id that is not open yet", () => {
    const w = world([draft("a"), draft("b")]);
    const r = openInTab(state(["a"], "a"), w, "b");
    expect(r.state.openTabs).toEqual(["a", "b"]);
    expect(r.state.currentId).toBe("b");
    check(r.state, w);
  });

  it("only moves the highlight for an id already open", () => {
    const w = world([draft("a"), draft("b")]);
    const r = openInTab(state(["a", "b"], "a"), w, "b");
    expect(r.state.openTabs).toEqual(["a", "b"]);
    expect(r.state.currentId).toBe("b");
    check(r.state, w);
  });

  it("ignores an unknown id", () => {
    const w = world([draft("a")]);
    const before = state(["a"], "a");
    expect(openInTab(before, w, "zzz").state).toBe(before);
  });
});

describe("removeDraftFromView", () => {
  it("moves to another open tab when the current one goes", () => {
    const w = world([draft("a"), draft("b")]);
    const r = removeDraftFromView(state(["a", "b"], "a"), w, "a");
    expect(r.state.openTabs).toEqual(["b"]);
    expect(r.state.currentId).toBe("b");
    check(r.state, w);
  });

  it("spawns a blank when the only tab goes", () => {
    const w = world([draft("a")]);
    const r = removeDraftFromView(state(["a"], "a"), w, "a");
    expect(r.state.openTabs).toEqual(["blank-1"]);
    check(r.state, w);
  });

  it("leaves the tabs alone for a draft that was not open", () => {
    const w = world([draft("a"), draft("b")]);
    const r = removeDraftFromView(state(["a"], "a", ["b"]), w, "b");
    expect(r.state.openTabs).toEqual(["a"]);
    expect(r.state.currentId).toBe("a");
    expect(r.state.closedStack).toEqual([]);
    expect(w.drafts.has("b")).toBe(false);
    check(r.state, w);
  });
});

describe("dropScratch", () => {
  it("removes an untouched blank", () => {
    const w = world([draft("a", ""), draft("b")]);
    const r = dropScratch(state(["a", "b"], "b"), w, "a");
    expect(r.state.openTabs).toEqual(["b"]);
    expect(w.drafts.has("a")).toBe(false);
    check(r.state, w);
  });

  it("keeps a tab that has content", () => {
    const w = world([draft("a"), draft("b")]);
    const before = state(["a", "b"], "b");
    expect(dropScratch(before, w, "a").state).toBe(before);
  });

  it("ignores a null id", () => {
    const w = world([draft("a")]);
    const before = state(["a"], "a");
    expect(dropScratch(before, w, null).state).toBe(before);
  });

  it("does not drop a blank that has a file behind it", () => {
    const w = world([draft("a", "", { file_path: "/tmp/a.txt" }), draft("b")]);
    const before = state(["a", "b"], "b");
    expect(dropScratch(before, w, "a").state).toBe(before);
  });
});

describe("activateBlank and newTab", () => {
  it("adds a blank and makes it current", () => {
    const w = world([draft("a")]);
    const r = activateBlank(state(["a"], "a"), w);
    expect(r.state.openTabs).toEqual(["a", "blank-1"]);
    expect(r.state.currentId).toBe("blank-1");
    check(r.state, w);
  });

  it("newTab does the same thing", () => {
    const w = world([draft("a")]);
    const r = newTab(state(["a"], "a"), w);
    expect(r.state.currentId).toBe("blank-1");
    check(r.state, w);
  });
});

describe("invariants hold across a long session", () => {
  it("survives a run of mixed transitions", () => {
    const w = world([draft("a"), draft("b"), draft("c")]);
    let s = state(["a", "b", "c"], "b");

    s = closeTab(s, w, "b").state;
    check(s, w);
    s = cycleTab(s, 1).state;
    check(s, w);
    s = newTab(s, w).state;
    check(s, w);
    s = closeTab(s, w, s.currentId).state;
    check(s, w);
    s = closeTab(s, w, "a").state;
    check(s, w);
    s = closeTab(s, w, "c").state;
    check(s, w);
    s = reopenClosedTab(s, w).state;
    check(s, w);
    s = removeDraftFromView(s, w, s.currentId).state;
    check(s, w);
  });
});
