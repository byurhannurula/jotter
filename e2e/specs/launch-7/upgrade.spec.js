// Upgrading must not cost anyone a note.
//
// The store this launch starts from is written in the shape the shipped
// version writes: no `cloud`, no `file_mtime`, and paths spelled the way they
// were saved. Both fields carry `#[serde(default)]`, but a store that failed
// to parse would come back as a set of blank drafts — and a blank, unnamed,
// file-less draft is exactly what `init_store` prunes. So the check is not
// "does it parse" but "is every note still there afterwards".
//
// `launch.json` gives this launch a data folder of its own: it seeds a whole
// store, and the launches before it must not see it.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { browser, $, expect } from "@wdio/globals";
import { autosave, click, dataDir, editorShows, fill, rows, storedDrafts } from "../../helpers.js";

const storeFile = (id) => join(dataDir(), "drafts", `${id}.json`);
const byId = (id) => storedDrafts().find((d) => d.id === id);

describe("a store written by the shipped version", () => {
  before(async () => {
    await $("#editor").waitForExist();
  });

  it("keeps every note that has anything in it", () => {
    expect(byId("draft-old-plain").content).toBe("milk\nbread");
    expect(byId("draft-old-plain").title).toBe("Shopping");
    expect(byId("draft-old-plain").pinned).toBe(true);
    expect(byId("draft-old-untitled").content).toBe("a note with no name");
    expect(byId("draft-old-titled-empty").title).toBe("Named but empty");
    expect(byId("draft-old-file").file_path).toContain("kept.txt");
  });

  it("shows them all in the sidebar, pinned one first", async () => {
    const list = await rows();
    expect(list[0].title).toBe("Shopping");
    expect(list.map((r) => r.title)).toEqual(
      expect.arrayContaining(["Shopping", "a note with no name", "Named but empty"]),
    );
  });

  it("keeps a note whose drive is not mounted, out of sight but not deleted", async () => {
    // Hidden from the sidebar because the file cannot be read, and still in the
    // store so it comes back when the drive does.
    const list = await rows();
    expect(list.map((r) => r.title)).not.toContain("On a drive that is not here");
    expect(existsSync(storeFile("draft-old-missing"))).toBe(true);
    expect(byId("draft-old-missing")).toBeDefined();
  });

  it("prunes only the draft with nothing in it at all", () => {
    // Blank text, no name, no file: the one case both sides agree is not a note.
    expect(existsSync(storeFile("draft-old-orphan"))).toBe(false);
    expect(storedDrafts().length).toBe(5);
  });

  it("reads a file it inherited from the old store", async () => {
    // The path came from the store, not from a dialog in this run, so this is
    // also the allow-list letting an inherited path through after the launch
    // canonicalises it.
    await click(`#draft-list .draft-item[data-id="draft-old-file"]`);
    await editorShows("text that was already on disk");
  });

  it("edits an old note without disturbing the others", async () => {
    await click(`#draft-list .draft-item[data-id="draft-old-plain"]`);
    await editorShows("milk\nbread");
    await fill("#editor", "milk\nbread\ncheese");
    await autosave();

    expect(byId("draft-old-plain").content).toBe("milk\nbread\ncheese");
    expect(byId("draft-old-untitled").content).toBe("a note with no name");
    expect(byId("draft-old-titled-empty").title).toBe("Named but empty");
    expect(readFileSync(join(dataDir(), "kept.txt"), "utf8")).toBe("text that was already on disk");
    expect(storedDrafts().length).toBe(5);
  });
});
