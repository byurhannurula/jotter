import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $, expect } from "@wdio/globals";
import {
  dataDir,
  autosave,
  clickToast,
  toastWith,
  page,
  editorShows,
  hostInvoke,
} from "../../helpers.js";

const file = () => join(dataDir(), "note.txt");

describe("launched with a file", () => {
  it("shows the file as the active tab", async () => {
    await $("#editor").waitForExist();
    await editorShows("hello from disk");
    expect((await page()).activeTab).toContain("note.txt");
  });

  it("writes typed text back to the file", async () => {
    await $("#editor").addValue("\nand a line from the app");
    // Wait for the keys to land, not for a fixed time. WKWebView delivers them
    // after `addValue` has returned, and a straggler arriving during the next
    // case shows up as a stray character in the middle of a note.
    await editorShows("hello from disk\nand a line from the app");
    await autosave();
    expect(readFileSync(file(), "utf8")).toBe("hello from disk\nand a line from the app");
  });

  it("raises the conflict prompt when the file changed outside, and Reload shows the disk text", async () => {
    writeFileSync(file(), "rewritten by another program");
    await $("#editor").addValue(" more");
    await editorShows("hello from disk\nand a line from the app more");
    await autosave();
    await toastWith("changed on disk");
    expect(readFileSync(file(), "utf8")).toBe("rewritten by another program"); // not overwritten
    expect(readFileSync(join(dataDir(), "note (conflicted copy).txt"), "utf8")).toContain("more");
    await clickToast("Reload");
    await editorShows("rewritten by another program");
  });

  it("still allows the same file spelled another way", async () => {
    // The allow-list holds canonical paths, so a spelling the page could
    // plausibly produce for a file the user did open has to pass. The refusals
    // live in launch-1; this is the other half of that check.
    const r = await hostInvoke("read_text_file", { path: `${dataDir()}/./note.txt` });
    expect(r.ok).toBe(true);
    expect(r.value[0]).toBe("rewritten by another program");
  });

  it("refuses a save that carries a stale mtime, even for a file the user opened", async () => {
    // The path is allowed; what is wrong is the mtime the draft remembers. The
    // toast flow above proves the app notices; this proves the host does, so a
    // page that skipped the check could not overwrite the file either.
    const r = await hostInvoke("save_draft", {
      draft: {
        id: "stale-mtime",
        content: "written from a stale draft",
        file_path: `${dataDir()}/note.txt`,
        file_mtime: 1,
      },
    });
    expect(r.ok).toBe(false);
    expect(r.err).toContain("conflict");
    expect(readFileSync(file(), "utf8")).toBe("rewritten by another program");
  });
});
