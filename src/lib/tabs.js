// The tab model: which drafts are open, which one is current, and what can be
// reopened. This is the most intricate state in the app and the place where
// every "which tab is active now?" bug lives, so it is kept separate from the
// DOM and exercised by tabs.test.js.
//
// Each transition takes the current state and returns a new one, plus the
// side effects the caller should carry out (`{ type: "delete", id }` to remove a
// draft from the store, `{ type: "activate", id }` to load a draft). The
// `drafts` Map is the in-memory model rather than IO, so transitions do write to
// it — adding a blank, dropping a pruned one — while leaving disk and DOM alone.

import { isEmpty } from "./text.js";

/**
 * @typedef {{ openTabs: string[], currentId: string | null, closedStack: string[] }} TabState
 * @typedef {{ drafts: Map<string, any>, makeBlank: () => any }} Deps
 * @typedef {{ state: TabState, effects: Array<{ type: string, id?: string }> }} Result
 */

/** A draft worth remembering on the reopen stack. */
const isSaved = (d) => !isEmpty(d);

const clone = (s) => ({
  openTabs: [...s.openTabs],
  currentId: s.currentId,
  closedStack: [...s.closedStack],
});

const unchanged = (s) => ({ state: s, effects: [] });

/** Add a fresh blank draft and make it current. */
export function activateBlank(state, deps) {
  const next = clone(state);
  const d = deps.makeBlank();
  deps.drafts.set(d.id, d);
  next.openTabs.push(d.id);
  next.currentId = d.id;
  return { state: next, effects: [{ type: "activate", id: d.id }] };
}

/** Open a draft that already exists, or just move to it if it is open. */
export function openInTab(state, deps, id) {
  if (!deps.drafts.has(id)) return unchanged(state);
  const next = clone(state);
  if (!next.openTabs.includes(id)) next.openTabs.push(id);
  next.currentId = id;
  return { state: next, effects: [{ type: "activate", id }] };
}

/** A brand new empty tab. */
export function newTab(state, deps) {
  return activateBlank(state, deps);
}

/**
 * Close a tab. The draft itself survives unless it was an untouched blank, in
 * which case it is pruned from the store — there is nothing in it to keep.
 * Callers flush pending edits before asking, since "is it blank" is decided on
 * the model's content and the editor may be ahead of it.
 * Closing the only tab leaves a fresh blank behind rather than no editor, and
 * closing an already-blank only tab does nothing at all.
 */
export function closeTab(state, deps, id) {
  const idx = state.openTabs.indexOf(id);
  if (idx === -1) return unchanged(state);

  const d = deps.drafts.get(id);
  if (state.openTabs.length === 1 && d && isEmpty(d)) return unchanged(state);

  const wasCurrent = id === state.currentId;
  const next = clone(state);
  const effects = [];

  next.openTabs.splice(idx, 1);
  if (d && isSaved(d)) next.closedStack.push(id);
  if (d && isEmpty(d)) {
    deps.drafts.delete(id);
    effects.push({ type: "delete", id });
  }

  if (next.openTabs.length === 0) {
    const blank = activateBlank(next, deps);
    return { state: blank.state, effects: [...effects, ...blank.effects] };
  }
  if (wasCurrent) {
    // The tab that slid into this slot, or the last one if this was the end.
    const nextId = next.openTabs[Math.min(idx, next.openTabs.length - 1)];
    next.currentId = nextId;
    effects.push({ type: "activate", id: nextId });
  }
  return { state: next, effects };
}

/** Step to the next or previous tab, wrapping at both ends. */
export function cycleTab(state, dir) {
  if (state.openTabs.length < 2) return unchanged(state);
  const i = state.openTabs.indexOf(state.currentId);
  const n = (i + dir + state.openTabs.length) % state.openTabs.length;
  const next = clone(state);
  next.currentId = state.openTabs[n];
  return { state: next, effects: [{ type: "activate", id: next.currentId }] };
}

/** Reopen the most recently closed draft that still exists. */
export function reopenClosedTab(state, deps) {
  const next = clone(state);
  while (next.closedStack.length) {
    const id = next.closedStack.pop();
    if (deps.drafts.has(id)) {
      const opened = openInTab(next, deps, id);
      return { state: { ...opened.state, closedStack: next.closedStack }, effects: opened.effects };
    }
  }
  return { state: next, effects: [] };
}

/**
 * Forget a draft entirely: out of the store, out of the tabs, out of the reopen
 * stack. Does not touch disk — the caller decides whether this is a delete or
 * a draft that turned out not to exist.
 */
export function removeDraftFromView(state, deps, id) {
  const next = clone(state);
  deps.drafts.delete(id);
  next.openTabs = next.openTabs.filter((t) => t !== id);
  next.closedStack = next.closedStack.filter((t) => t !== id);

  if (state.currentId !== id) return { state: next, effects: [] };
  if (next.openTabs.length === 0) return activateBlank(next, deps);

  next.currentId = next.openTabs[next.openTabs.length - 1];
  return { state: next, effects: [{ type: "activate", id: next.currentId }] };
}

/**
 * Drop an untouched blank tab, used when a file opens and the empty page it
 * would land next to has nothing in it. A tab with any content is left alone.
 */
export function dropScratch(state, deps, id) {
  const d = id && deps.drafts.get(id);
  if (!d || !isEmpty(d)) return unchanged(state);
  const next = clone(state);
  next.openTabs = next.openTabs.filter((t) => t !== id);
  deps.drafts.delete(id);
  return { state: next, effects: [{ type: "forget", id }] };
}
