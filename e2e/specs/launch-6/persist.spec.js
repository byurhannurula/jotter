// What had to survive the quit in launch-5, plus what launch-4 left behind.
// The first case is the interesting one: that text was typed with no time left
// for the autosave, so it can only be on disk because the host held the quit
// open until the page had written it.

import { browser, $, expect } from "@wdio/globals";
import { bodyHas, click, isHidden, menu, rows, storedDrafts } from "../../helpers.js";

const SECOND = "second draft text";
const RENAMED = "Renamed by the suite";
const LAST_LINE = "typed with no time to autosave";

describe("after the app was told to quit", () => {
  before(async () => {
    await $("#editor").waitForExist();
    if (await bodyHas("sidebar-hidden")) await menu("toggle_sidebar");
    await browser.waitUntil(async () => !(await bodyHas("sidebar-hidden")));
  });

  it("kept the keystrokes that had not been autosaved", async () => {
    expect(storedDrafts().map((d) => d.content)).toContain(LAST_LINE);
  });

  it("starts on a blank tab, with both drafts in the sidebar", async () => {
    await expect($("#editor")).toHaveValue("");
    const list = await rows();
    expect(list.map((r) => r.title)).toContain(RENAMED);
    expect(list.map((r) => r.title)).toContain(SECOND);
  });

  it("still shows the pinned draft first", async () => {
    const list = await rows();
    expect(list[0].title).toBe(SECOND);
    expect(list[0].pinned).toBe(true);
  });

  it("still has the settings the last run chose", async () => {
    expect(await browser.execute(() => document.documentElement.dataset.theme)).toBe("dark");
    expect(await bodyHas("no-statusbar")).toBe(true);
  });

  it("puts those settings back", async () => {
    // The suite leaves the machine as it found it: the webview's storage is
    // outside the throwaway data folder, so a setting left switched here would
    // outlive the run.
    await menu("settings");
    await click("#set-theme button[data-val='system']");
    if (await bodyHas("no-statusbar")) await click("#set-statusbar");
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => document.documentElement.dataset.theme ?? null)) === null,
    );
    expect(await bodyHas("no-statusbar")).toBe(false);
    await click("#settings-close");
    await browser.waitUntil(async () => (await isHidden("#settings")) === true);
  });
});
