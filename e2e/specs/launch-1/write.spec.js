import { browser, $, expect } from "@wdio/globals";
import { storedDrafts, sleep, AUTOSAVE_MS } from "../../helpers.js";

describe("first launch", () => {
  it("starts on a blank page with the editor focused", async () => {
    const editor = $("#editor");
    await editor.waitForExist();
    await expect(editor).toHaveValue("");
    expect(await browser.execute(() => document.activeElement?.id)).toBe("editor");
  });

  it("autosaves what is typed into the store folder", async () => {
    await $("#editor").addValue("first line of a note");
    await sleep(AUTOSAVE_MS + 300);
    const drafts = storedDrafts();
    expect(drafts.map((d) => d.content)).toEqual(["first line of a note"]);
  });
});
