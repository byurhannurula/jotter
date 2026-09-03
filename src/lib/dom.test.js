// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { el } from "./dom.js";

describe("el", () => {
  it("sets the shorthands and properties", () => {
    const b = el("button", {
      class: "a b",
      text: "Go",
      id: "go",
      type: "button",
      title: "t",
      disabled: true,
      tabIndex: -1,
    });
    expect(b.tagName).toBe("BUTTON");
    expect(b.className).toBe("a b");
    expect(b.textContent).toBe("Go");
    expect(b.id).toBe("go");
    expect(b.type).toBe("button");
    expect(b.title).toBe("t");
    expect(b.disabled).toBe(true);
    expect(b.tabIndex).toBe(-1);
  });

  it("sets role, aria and data attributes", () => {
    const li = el("li", {
      role: "option",
      aria: { selected: "true", label: "x" },
      data: { id: "d1" },
    });
    expect(li.getAttribute("role")).toBe("option");
    expect(li.getAttribute("aria-selected")).toBe("true");
    expect(li.getAttribute("aria-label")).toBe("x");
    expect(li.dataset.id).toBe("d1");
  });

  it("wires listeners and appends children, strings included", () => {
    const click = vi.fn();
    const span = el("span", { text: "in" });
    const d = el("div", { on: { click } }, "before ", span);
    d.click();
    expect(click).toHaveBeenCalledTimes(1);
    expect(d.childNodes.length).toBe(2);
    expect(d.textContent).toBe("before in");
  });

  it("sets html and skips null or undefined values", () => {
    const d = el("div", { html: "<b>x</b>", title: undefined, id: null });
    expect(d.querySelector("b")?.textContent).toBe("x");
    expect(d.hasAttribute("title")).toBe(false);
    expect(d.id).toBe("");
  });
});
