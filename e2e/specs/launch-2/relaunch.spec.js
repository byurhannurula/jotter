import { browser, $, expect } from "@wdio/globals";
import {
  storedDrafts,
  autosave,
  bodyHas,
  contextMenu,
  clickToast,
  sleep,
  menu,
  page,
  editorShows,
} from "../../helpers.js";

const NOTE = "first line of a note";

describe("relaunch", () => {
  it("starts blank again, with the earlier note in the store", async () => {
    await $("#editor").waitForExist();
    await expect($("#editor")).toHaveValue("");
    expect(storedDrafts().map((d) => d.content)).toEqual([NOTE]);
  });

  it("lists the earlier note in the sidebar and opens it", async () => {
    await menu("toggle_sidebar");
    await browser.waitUntil(async () => !(await bodyHas("sidebar-hidden")));
    expect((await page()).rows.length).toBe(1);
    await $("#draft-list .draft-item").click();
    await editorShows(NOTE);
  });

  it("closes the tab and reopens it with its text", async () => {
    await menu("close_tab");
    await editorShows("");
    expect((await page()).tabs).toEqual(["New Draft"]);
    await menu("reopen_tab");
    await editorShows(NOTE);
  });

  it("enters focus mode and two Escapes leave it", async () => {
    await browser.keys(["Control", "Meta", "f"]);
    await browser.waitUntil(() => bodyHas("focus-mode"));
    await browser.keys(["Escape"]);
    await browser.keys(["Escape"]);
    await browser.waitUntil(async () => !(await bodyHas("focus-mode")));
    await editorShows(NOTE);
  });

  it("delete then Undo brings the note back", async () => {
    await contextMenu("Delete");
    await editorShows("");
    await clickToast("Undo");
    await browser.waitUntil(async () => (await page()).rows.length === 1);
    expect(storedDrafts().map((d) => d.content)).toEqual([NOTE]);
  });

  it("delete and wait removes the note from the store", async () => {
    await contextMenu("Delete");
    await sleep(6_500); // the undo grace period is 6s
    expect(storedDrafts()).toEqual([]);
    await autosave();
    expect(storedDrafts()).toEqual([]); // nothing brings it back
  });
});
