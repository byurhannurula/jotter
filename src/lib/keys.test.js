import { describe, it, expect } from "vitest";
import { tabKeyAction } from "./keys.js";

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
