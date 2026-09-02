// One stack for every overlay (settings, quick switcher, rename prompt), so
// Escape closes the top one, Tab stays inside it, and focus goes back to where
// it was when it closes. Before this each overlay handled those itself, in
// three slightly different ways, and none of them trapped or restored focus.
//
// DOM-only, no app state: takes elements, returns elements.

const stack = []; // { el, opener }

const FOCUSABLE =
  "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), " +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Elements inside `root` that can take focus and are not inside a hidden
 *  subtree. Checked by attribute rather than layout so it works without a
 *  renderer. */
export function focusables(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter((el) => !el.closest("[hidden]"));
}

/** Show an overlay: remember what had focus, so close() can give it back. */
export function open(el) {
  if (stack.some((m) => m.el === el)) return;
  stack.push({ el, opener: document.activeElement });
  el.hidden = false;
}

/** Hide an overlay and return focus to its opener. `hide` may animate; it is
 *  responsible for setting `el.hidden` when done. */
export function close(el, hide = (e) => (e.hidden = true)) {
  const i = stack.findIndex((m) => m.el === el);
  if (i === -1) return;
  const [{ opener }] = stack.splice(i, 1);
  hide(el);
  if (opener && opener.isConnected && typeof opener.focus === "function") opener.focus();
}

/** The overlay on top, or null. */
export function top() {
  return stack.length ? stack[stack.length - 1].el : null;
}

export function any() {
  return stack.length > 0;
}

/** Move focus to the first focusable thing inside `el`. */
export function focusFirst(el) {
  focusables(el)[0]?.focus();
}

/** keydown handler for an overlay root: keep Tab and Shift+Tab inside it. */
export function trapTab(e) {
  if (e.key !== "Tab") return;
  const items = focusables(e.currentTarget);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (e.shiftKey && (active === first || !e.currentTarget.contains(active))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (active === last || !e.currentTarget.contains(active))) {
    e.preventDefault();
    first.focus();
  }
}

/** Roving focus among `items` for a listbox, tablist or menu: arrows move,
 *  Home and End jump, and the focused item is the only one in the tab order.
 *  Returns the newly focused element, or null if the key was not handled. */
export function roveFocus(e, items, { vertical = false } = {}) {
  if (!items.length) return null;
  const i = items.indexOf(document.activeElement);
  const next = vertical ? "ArrowDown" : "ArrowRight";
  const prev = vertical ? "ArrowUp" : "ArrowLeft";
  let target = null;
  if (e.key === next) target = items[(i + 1) % items.length];
  else if (e.key === prev) target = items[(i - 1 + items.length) % items.length];
  else if (e.key === "Home") target = items[0];
  else if (e.key === "End") target = items[items.length - 1];
  if (!target) return null;
  e.preventDefault();
  for (const it of items) it.tabIndex = it === target ? 0 : -1;
  target.focus();
  return target;
}
