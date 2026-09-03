import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $, expect } from "@wdio/globals";
import { dataDir, autosave, clickToast, toastWith, page, editorShows } from "../../helpers.js";

const file = () => join(dataDir(), "note.txt");

describe("launched with a file", () => {
  it("shows the file as the active tab", async () => {
    await $("#editor").waitForExist();
    await editorShows("hello from disk");
    expect((await page()).activeTab).toContain("note.txt");
  });

  it("writes typed text back to the file", async () => {
    await $("#editor").addValue("\nand a line from the app");
    await autosave();
    expect(readFileSync(file(), "utf8")).toBe("hello from disk\nand a line from the app");
  });

  it("raises the conflict prompt when the file changed outside, and Reload shows the disk text", async () => {
    writeFileSync(file(), "rewritten by another program");
    await $("#editor").addValue(" more");
    await autosave();
    await toastWith("changed on disk");
    expect(readFileSync(file(), "utf8")).toBe("rewritten by another program"); // not overwritten
    expect(readFileSync(join(dataDir(), "note (conflicted copy).txt"), "utf8")).toContain("more");
    await clickToast("Reload");
    await editorShows("rewritten by another program");
  });
});
