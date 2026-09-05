// The editing surfaces, valid and invalid, in a real webview: two tabs, the
// quick switcher, find and replace, rename, pin, preview, settings. The
// happy-dom layer already walks these; what it cannot show is that they still
// work when the DOM is a real one, the store is a real folder, and the styles
// that hide and show things are the shipped ones.
//
// Quitting is launch-5, which needs an app it is allowed to kill.

import { browser, $, expect } from "@wdio/globals";
import {
  autosave,
  bodyHas,
  click,
  contextMenu,
  currentId,
  editorShows,
  fill,
  isHidden,
  menu,
  page,
  rows,
  storedDrafts,
  text,
  toastWith,
} from "../../helpers.js";

const FIRST = "alpha beta ALPHA gamma";
const SECOND = "second draft text";
const REPLACED = "delta beta delta gamma";
const RENAMED = "Renamed by the suite";

// Raw HTML in a note is text, not markup: markdown-it runs with html: false.
const MARKDOWN = `# Heading\n\n<b>bold</b>\n\n<img src=x onerror="window.__pwned = 1">`;

let first;
let second;

describe("editing in the real window", () => {
  before(async () => {
    await $("#editor").waitForExist();
    if (await bodyHas("sidebar-hidden")) await menu("toggle_sidebar");
    await browser.waitUntil(async () => !(await bodyHas("sidebar-hidden")));
  });

  it("keeps two tabs apart", async () => {
    await fill("#editor", FIRST);
    await autosave();
    first = await currentId();

    await menu("new");
    await editorShows("");
    await fill("#editor", SECOND);
    await autosave();
    second = await currentId();

    expect(first).not.toBe(second);
    expect((await page()).tabs.length).toBe(2);

    await menu("prev_tab");
    await editorShows(FIRST);
    await menu("next_tab");
    await editorShows(SECOND);
  });

  it("says so when the switcher matches nothing, and Escape changes no tab", async () => {
    await menu("switcher");
    expect(await isHidden("#switcher")).toBe(false);
    await fill("#switcher-input", "zzzz-nothing-matches-this");
    expect(await text("#switcher-list")).toBe("No matching drafts");

    await browser.keys(["Escape"]);
    await browser.waitUntil(async () => (await isHidden("#switcher")) === true);
    await editorShows(SECOND);
  });

  it("opens the other draft through the switcher", async () => {
    await menu("switcher");
    await fill("#switcher-input", "alpha");
    await click("#switcher-list .switcher-item");
    await editorShows(FIRST);
    expect(await currentId()).toBe(first);
  });

  it("counts matches, honours case, and says when there are none", async () => {
    await menu("find");
    await fill("#find-input", "alpha");
    expect(await text("#find-count")).toBe("1 of 2");

    await click("#find-case"); // ALPHA no longer counts
    expect(await text("#find-count")).toBe("1 of 1");
    await click("#find-case");
    expect(await text("#find-count")).toBe("1 of 2");

    await fill("#find-input", "zzz");
    expect(await text("#find-count")).toBe("No results");
  });

  it("replaces every match, and the store keeps the result", async () => {
    await fill("#find-input", "alpha");
    await click("#find-replace-toggle");
    await fill("#replace-input", "delta");
    await click("#replace-all");
    await editorShows(REPLACED);

    await click("#find-close");
    await autosave();
    expect(storedDrafts().find((d) => d.id === first).content).toBe(REPLACED);
  });

  it("leaves the title alone when a rename is cancelled or left blank", async () => {
    const before = (await rows()).find((r) => r.id === first).title;

    await contextMenu("Rename…", first);
    await fill("#prompt-input", "not this one");
    await click("#prompt-cancel");
    await browser.waitUntil(async () => (await isHidden("#prompt")) === true);
    expect((await rows()).find((r) => r.id === first).title).toBe(before);

    await contextMenu("Rename…", first);
    await fill("#prompt-input", "   "); // trims to nothing, so it counts as cancel
    await click("#prompt-ok");
    await browser.waitUntil(async () => (await isHidden("#prompt")) === true);
    expect((await rows()).find((r) => r.id === first).title).toBe(before);
  });

  it("renames a draft, and the new title reaches the store", async () => {
    await contextMenu("Rename…", first);
    await fill("#prompt-input", RENAMED);
    await click("#prompt-ok");
    await browser.waitUntil(async () => (await isHidden("#prompt")) === true);
    expect((await rows()).find((r) => r.id === first).title).toBe(RENAMED);
    await browser.waitUntil(() => storedDrafts().find((d) => d.id === first)?.title === RENAMED);
  });

  it("pins a draft above the rest", async () => {
    await contextMenu("Pin", second);
    await toastWith("Pinned to top");
    const list = await rows();
    expect(list[0].id).toBe(second);
    expect(list[0].pinned).toBe(true);
    expect(storedDrafts().find((d) => d.id === second).pinned).toBe(true);
  });

  it("renders markdown in preview and leaves raw HTML as text", async () => {
    await fill("#editor", MARKDOWN);
    // The preview renders the draft, not the textarea, and the two meet on the
    // next animation frame (`flushUi`). A person clicking the button cannot get
    // there first; a test firing both in the same breath can.
    await autosave();
    await menu("toggle_preview");
    await browser.waitUntil(async () => (await isHidden("#preview")) === false);

    const view = await browser.execute(() => {
      const p = document.getElementById("preview");
      return {
        heading: p.querySelector("h1")?.textContent ?? null,
        elements: [...p.querySelectorAll("b, img, script")].map((n) => n.tagName),
        showsTheTagAsText: p.textContent.includes("<b>bold</b>"),
        pwned: window.__pwned ?? null,
        editorHidden: document.getElementById("editor").hidden,
      };
    });

    expect(view.heading).toBe("Heading");
    expect(view.elements).toEqual([]);
    expect(view.showsTheTagAsText).toBe(true);
    expect(view.pwned).toBe(null);
    expect(view.editorHidden).toBe(true);

    await menu("toggle_preview");
    await browser.waitUntil(async () => (await isHidden("#preview")) === true);
  });

  it("draws the shared icons from the sprite", async () => {
    // The pencil and the cloud are <symbol>s the page and main.js both point
    // at. A <use> whose id no longer resolves draws nothing at all, and the
    // build minifies the page that carries the ids, so this is worth asking of
    // the built app rather than of the source.
    const icons = await browser.execute(() =>
      [...document.querySelectorAll("use")].map((u) => {
        const id = (u.getAttribute("href") ?? u.getAttribute("xlink:href") ?? "").slice(1);
        const box = u.getBoundingClientRect();
        return { id, resolves: !!document.getElementById(id), drawn: box.width > 0 };
      }),
    );

    expect(icons.length).toBeGreaterThan(0);
    expect(icons.filter((i) => !i.resolves)).toEqual([]);
    expect(icons.some((i) => i.drawn)).toBe(true);
  });

  it("applies a settings change to the window", async () => {
    // Settings live in the webview's localStorage, which sits outside the
    // throwaway data folder and so survives from run to run. Nothing here may
    // assume a starting value: the segment is set to the one wanted (clicking
    // the active option is a no-op), and the switch is only clicked if it is
    // not already where the test needs it. launch-5 puts both back.
    await menu("settings");
    expect(await isHidden("#settings")).toBe(false);

    await click("#set-theme button[data-val='dark']");
    await browser.waitUntil(
      async () => (await browser.execute(() => document.documentElement.dataset.theme)) === "dark",
    );

    if (!(await bodyHas("no-statusbar"))) await click("#set-statusbar");
    await browser.waitUntil(() => bodyHas("no-statusbar"));
    expect(await browser.execute(() => document.getElementById("set-statusbar").ariaChecked)).toBe(
      "false",
    );

    await click("#settings-close");
    await browser.waitUntil(async () => (await isHidden("#settings")) === true);
  });
});
