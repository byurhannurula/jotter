// Keyboard decisions, kept apart from the DOM so they can be tested directly.
// The handlers in main.js do the reading and writing; what a keypress *means*
// lives here.

/** Keys that report themselves as a keydown before the key they modify. */
const MODIFIER_KEYS = new Set(["Shift", "Alt", "Control", "Meta"]);

/**
 * What a keydown in the editor means for the Tab key.
 *
 * `armed` is the Escape-then-Tab escape hatch: an editor that captures Tab is a
 * keyboard trap without one. Escape arms it, and the next Tab is handed to the
 * browser so focus can move on.
 *
 * The subtlety this exists to pin down: pressing Shift+Tab delivers a keydown
 * for Shift *first*. Treating that as "some other key" disarmed the flag before
 * the Tab it belonged to ever arrived, so the backward exit could never work.
 *
 * @param {{key: string, shiftKey?: boolean, metaKey?: boolean, ctrlKey?: boolean, altKey?: boolean}} e
 * @param {{mode: string, armed: boolean}} state `mode` is the tabkey setting.
 * @returns {{action: "ignore"|"arm"|"release"|"indent"|"outdent", armed: boolean}}
 *   `release` means let the browser have the key; the rest are ours.
 */
export function tabKeyAction(e, { mode, armed }) {
  if (e.key === "Escape") return { action: "arm", armed: true };

  // A modifier on its own settles nothing, so leave the flag as it is.
  if (MODIFIER_KEYS.has(e.key)) return { action: "ignore", armed };

  // Any other key means the user moved on; ⌘/⌃/⌥+Tab belong to other handlers.
  if (e.key !== "Tab" || e.metaKey || e.ctrlKey || e.altKey) {
    return { action: "ignore", armed: false };
  }

  if (armed) return { action: "release", armed: false };
  if (mode === "off") return { action: "release", armed: false };
  return { action: e.shiftKey ? "outdent" : "indent", armed: false };
}

/**
 * Global chords the page handles itself rather than through the native menu.
 * Matched on `code` where the letter matters, so they are layout- and
 * case-independent; modifiers must match exactly.
 *
 * Why these are here and not menu accelerators:
 * - Tab cycling: Control+Tab accelerators do not fire reliably on macOS.
 * - Focus mode: ⌃⌘F is on the View menu too, but macOS has owned that chord
 *   for Enter Full Screen for years and can swallow it before the menu item
 *   sees it. ⇧⌘F is a second, unreserved way in for when the system wins.
 * - Draft actions mirror the context menu hints and act on the active draft.
 */
export const CHORDS = [
  { id: "cycle-next", key: "Tab", ctrl: true },
  { id: "cycle-prev", key: "Tab", ctrl: true, shift: true },
  { id: "focus-mode", code: "KeyF", meta: true, ctrl: true },
  { id: "focus-mode", code: "KeyF", meta: true, shift: true },
  { id: "share", code: "KeyL", meta: true, shift: true },
  { id: "export", code: "KeyE", meta: true, shift: true },
  { id: "pin", code: "KeyP", meta: true, ctrl: true },
  { id: "delete", code: "Backspace", meta: true },
  { id: "delete", code: "Delete", meta: true },
];

const MODS = ["meta", "ctrl", "shift", "alt"];

/**
 * The chord id a keydown matches, or null.
 * @param {{key: string, code?: string, metaKey?: boolean, ctrlKey?: boolean, shiftKey?: boolean, altKey?: boolean}} e
 */
export function shortcutOf(e) {
  for (const c of CHORDS) {
    const keyHit = c.code ? e.code === c.code : e.key === c.key;
    if (keyHit && MODS.every((m) => !!e[`${m}Key`] === !!c[m])) return c.id;
  }
  return null;
}
