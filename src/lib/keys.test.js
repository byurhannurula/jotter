import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { tabKeyAction, shortcutOf, CHORDS } from "./keys.js";

const key = (k, mods = {}) => ({
  key: k,
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  ...mods,
});

/** Feed a run of keys through in order, returning every action taken. */
function sequence(keys, mode = "indent") {
  let armed = false;
  return keys.map((k) => {
    const r = tabKeyAction(k, { mode, armed });
    armed = r.armed;
    return r.action;
  });
}

describe("tabKeyAction", () => {
  it("indents on Tab and outdents on Shift+Tab", () => {
    expect(tabKeyAction(key("Tab"), { mode: "indent", armed: false }).action).toBe("indent");
    expect(
      tabKeyAction(key("Tab", { shiftKey: true }), { mode: "indent", armed: false }).action,
    ).toBe("outdent");
  });

  it("hands Tab to the browser when the setting says move focus", () => {
    expect(tabKeyAction(key("Tab"), { mode: "off", armed: false }).action).toBe("release");
  });

  it("leaves modified Tab to the handlers that own it", () => {
    for (const mod of ["metaKey", "ctrlKey", "altKey"]) {
      const r = tabKeyAction(key("Tab", { [mod]: true }), { mode: "indent", armed: false });
      expect(r.action).toBe("ignore");
    }
  });

  it("arms on Escape", () => {
    const r = tabKeyAction(key("Escape"), { mode: "indent", armed: false });
    expect(r).toEqual({ action: "arm", armed: true });
  });

  it("releases the next Tab once armed, then disarms", () => {
    expect(sequence([key("Escape"), key("Tab")])).toEqual(["arm", "release"]);
    expect(sequence([key("Escape"), key("Tab"), key("Tab")])).toEqual(["arm", "release", "indent"]);
  });

  it("releases a backward Tab too", () => {
    // The regression this module exists for: Shift reports its own keydown
    // before the Tab, and disarming there meant Esc-then-Shift-Tab never
    // escaped the editor.
    expect(sequence([key("Escape"), key("Shift"), key("Tab", { shiftKey: true })])).toEqual([
      "arm",
      "ignore",
      "release",
    ]);
  });

  it("keeps the arming across any modifier keydown", () => {
    for (const mod of ["Shift", "Alt", "Control", "Meta"]) {
      expect(tabKeyAction(key(mod), { mode: "indent", armed: true }).armed).toBe(true);
    }
  });

  it("does not arm from a modifier on its own", () => {
    expect(tabKeyAction(key("Shift"), { mode: "indent", armed: false }).armed).toBe(false);
  });

  it("loses the arming as soon as the user types something else", () => {
    expect(sequence([key("Escape"), key("a"), key("Tab")])).toEqual(["arm", "ignore", "indent"]);
  });

  it("still escapes when the setting already hands Tab over", () => {
    expect(sequence([key("Escape"), key("Tab")], "off")).toEqual(["arm", "release"]);
  });
});

describe("shortcutOf", () => {
  const chord = (mods, k) => ({ key: k.key ?? "x", code: k.code ?? "", ...mods });
  const meta = { metaKey: true };
  const metaShift = { metaKey: true, shiftKey: true };
  const metaCtrl = { metaKey: true, ctrlKey: true };

  it("maps each chord to its action", () => {
    expect(shortcutOf(chord({ ctrlKey: true }, { key: "Tab" }))).toBe("cycle-next");
    expect(shortcutOf(chord({ ctrlKey: true, shiftKey: true }, { key: "Tab" }))).toBe("cycle-prev");
    expect(shortcutOf(chord(metaCtrl, { code: "KeyF" }))).toBe("focus-mode");
    expect(shortcutOf(chord(metaShift, { code: "KeyF" }))).toBe("focus-mode");
    expect(shortcutOf(chord(metaShift, { code: "KeyL" }))).toBe("share");
    expect(shortcutOf(chord(metaShift, { code: "KeyE" }))).toBe("export");
    expect(shortcutOf(chord(metaCtrl, { code: "KeyP" }))).toBe("pin");
    expect(shortcutOf(chord(meta, { code: "Backspace" }))).toBe("delete");
    expect(shortcutOf(chord(meta, { code: "Delete" }))).toBe("delete");
  });

  it("needs the exact modifiers", () => {
    expect(shortcutOf(chord({ metaKey: true }, { key: "Tab" }))).toBeNull();
    expect(shortcutOf(chord({ ctrlKey: true, altKey: true }, { key: "Tab" }))).toBeNull();
    expect(
      shortcutOf(chord({ metaKey: true, ctrlKey: true, shiftKey: true }, { code: "KeyF" })),
    ).toBeNull();
    expect(shortcutOf(chord(meta, { code: "KeyL" }))).toBeNull(); // ⌘L alone is not share
    expect(shortcutOf(chord(metaShift, { code: "KeyP" }))).toBeNull(); // ⇧⌘P is the menu's preview
    expect(shortcutOf(chord({}, { code: "Backspace" }))).toBeNull();
  });

  it("matches on code, not the typed character", () => {
    expect(shortcutOf({ key: "ł", code: "KeyL", ...metaShift })).toBe("share");
  });

  it("is shown in the Shortcuts help list in main.js", () => {
    const main = readFileSync(new URL("../main.js", import.meta.url), "utf8");
    const start = main.indexOf("const SHORTCUTS = [");
    const list = main.slice(start, main.indexOf("\n];", start));
    const symbol = (c) => {
      const key = c.code ? c.code.replace(/^Key/, "") : c.key;
      if (key === "Delete") return null; // the forward-delete alias of ⌘⌫
      const shown = { Backspace: "⌫" }[key] ?? key;
      return `${c.ctrl ? "⌃" : ""}${c.shift ? "⇧" : ""}${c.meta ? "⌘" : ""}${shown}`;
    };
    for (const c of CHORDS) {
      const s = symbol(c);
      if (s) expect(list, `${c.id} shown as ${s}`).toContain(s);
    }
  });

  it("has no two chords with the same keys", () => {
    const sig = (c) => [c.key, c.code, !!c.meta, !!c.ctrl, !!c.shift, !!c.alt].join("|");
    expect(new Set(CHORDS.map(sig)).size).toBe(CHORDS.length);
  });
});
