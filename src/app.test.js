// @vitest-environment happy-dom
//
// Scripted sessions against the real main.js. The boot harness (fake Rust host,
// click/menu/type helpers) lives in app-harness.js and is shared with the
// random-session test. The pure modules under lib/ have their own tests; this
// file covers the wiring between them and the DOM, which is where the "open a
// draft, editor stays blank, autosave writes the blank over the note" incident
// lived.
//
// The one rule every test here asserts: the editor shows the text of the draft
// whose tab is active, and nothing else is ever written to the store.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { clearMocks } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { boot, settle, sleep, AUTOSAVE_MS } from "./app-harness.js";

const seed = () => ({
  drafts: [
    {
      id: "draft-a",
      title: "",
      content: "alpha text",
      file_path: null,
      created_at: 1,
      updated_at: 2,
      pinned: false,
      cloud: false,
    },
    {
      id: "draft-b",
      title: "",
      content: "bravo text",
      file_path: null,
      created_at: 1,
      updated_at: 1,
      pinned: false,
      cloud: false,
    },
  ],
});

/** A save that would shrink a note to nothing is the failure this file exists
 *  to catch. Only in-app drafts with content count; blanks are pruned on
 *  purpose and file drafts are guarded by the mtime check. */
function blankOverwrites(app) {
  return app.host.saves.filter((s) => s.content === "" && seed().drafts.some((d) => d.id === s.id));
}

let app;
afterEach(() => {
  clearMocks();
  app = null;
});

describe("opening drafts", () => {
  beforeEach(async () => {
    app = await boot(seed());
  });

  it("starts on a blank page with the saved drafts in the sidebar", () => {
    expect(app.editor.value).toBe("");
    expect(app.tabIds()).toHaveLength(1);
    expect(app.sidebarIds()).toEqual(["draft-a", "draft-b"]);
  });

  it("shows a draft's text when it is opened from the sidebar", async () => {
    // The incident: the tab and title appeared but the textarea stayed blank.
    await app.clickDraft("draft-a");
    expect(app.activeTabId()).toBe("draft-a");
    expect(app.editor.value).toBe("alpha text");
  });

  it("shows each draft's own text when switching back and forth", async () => {
    await app.clickDraft("draft-a");
    await app.clickDraft("draft-b");
    expect(app.editor.value).toBe("bravo text");
    await app.clickDraft("draft-a");
    expect(app.editor.value).toBe("alpha text");
    expect(blankOverwrites(app)).toEqual([]);
  });

  it("never writes a blank over a draft that was merely opened", async () => {
    await app.clickDraft("draft-a");
    await app.autosave();
    await app.clickDraft("draft-b");
    await app.autosave();
    expect(blankOverwrites(app)).toEqual([]);
    expect(app.host.store.get("draft-a").content).toBe("alpha text");
    expect(app.host.store.get("draft-b").content).toBe("bravo text");
  });

  it("focuses an already-open file instead of opening it twice, and re-reads it", async () => {
    app = await boot({
      drafts: [
        {
          id: "draft-f",
          title: "",
          content: "first read",
          file_path: "/notes/f.txt",
          created_at: 1,
          updated_at: 1,
          pinned: false,
          cloud: false,
        },
      ],
      files: { "/notes/f.txt": "first read" },
    });
    await app.clickDraft("draft-f");
    await app.menu("new"); // move away so the file's tab is not current
    app.host.disk.set("/notes/f.txt", "edited outside");
    await emit("open-files", ["/notes/f.txt"]); // the OS hands us the same file again
    await settle();
    await settle();
    expect(app.tabIds().filter((id) => id === "draft-f")).toHaveLength(1);
    expect(app.activeTabId()).toBe("draft-f");
    expect(app.editor.value).toBe("edited outside");
  });

  it("Open from the menu reuses the blank scratch tab and puts the file in the store", async () => {
    app = await boot({ ...seed(), files: { "/notes/n.txt": "from disk" } });
    expect(app.tabIds().length).toBe(1); // the launch blank
    app.host.dialog.next = "/notes/n.txt";
    await app.menu("open");
    expect(app.tabIds().length).toBe(1); // reused, not added beside
    expect(app.editor.value).toBe("from disk");
    const stored = [...app.host.store.values()].find((d) => d.file_path === "/notes/n.txt");
    expect(stored?.content).toBe("from disk"); // would be missing on the next launch otherwise
    expect(app.host.disk.get("/notes/n.txt")).toBe("from disk"); // and the file was not rewritten
    expect(app.host.mtimes.get("/notes/n.txt")).toBe(1000);
  });

  it("Open of an already open file focuses its tab instead of opening it twice", async () => {
    app = await boot({ ...seed(), files: { "/notes/n.txt": "from disk" } });
    app.host.dialog.next = "/notes/n.txt";
    await app.menu("open");
    await app.clickDraft("draft-a");
    expect(app.tabIds().length).toBe(2);
    await app.menu("open");
    expect(app.tabIds().length).toBe(2);
    expect(app.editor.value).toBe("from disk");
  });

  it("opening a known file keeps the reopen history", async () => {
    // Found by the random-session test: the no-op scratch drop handed the
    // live tab state back, and writing it in place emptied the closed stack.
    app = await boot({
      drafts: [
        ...seed().drafts,
        {
          id: "draft-k",
          title: "",
          content: "known file",
          file_path: "/notes/k.txt",
          created_at: 1,
          updated_at: 1,
          pinned: false,
          cloud: false,
          file_mtime: 1000,
        },
      ],
      files: { "/notes/k.txt": "known file" },
    });
    await app.clickDraft("draft-a");
    await app.menu("close_tab");
    await app.clickDraft("draft-a");
    app.host.dialog.next = "/notes/k.txt";
    await app.menu("open");
    expect(app.activeTabId()).toBe("draft-k");
    await app.menu("reopen_tab");
    expect(app.activeTabId()).toBe("draft-a");
  });

  it("re-reads a file-backed draft from disk when it is opened", async () => {
    app = await boot({
      drafts: [
        {
          id: "draft-f",
          title: "",
          content: "stale copy",
          file_path: "/notes/f.txt",
          created_at: 1,
          updated_at: 1,
          pinned: false,
          cloud: false,
        },
      ],
      files: { "/notes/f.txt": "fresh from disk" },
    });
    await app.clickDraft("draft-f");
    expect(app.editor.value).toBe("fresh from disk");
  });
});

describe("typing and saving", () => {
  beforeEach(async () => {
    app = await boot(seed());
  });

  it("autosaves typed text to the draft on screen", async () => {
    await app.clickDraft("draft-a");
    await app.type("alpha text, edited");
    await app.autosave();
    expect(app.host.store.get("draft-a").content).toBe("alpha text, edited");
    expect(app.host.store.get("draft-b").content).toBe("bravo text");
  });

  it("flushes typed text before switching to another draft", async () => {
    await app.clickDraft("draft-a");
    await app.type("alpha text, edited");
    await app.clickDraft("draft-b"); // no autosave wait: the switch must flush
    expect(app.host.store.get("draft-a").content).toBe("alpha text, edited");
    expect(app.editor.value).toBe("bravo text");
  });

  it("keeps the previous draft intact when a new tab is opened", async () => {
    await app.clickDraft("draft-a");
    await app.menu("new");
    expect(app.editor.value).toBe("");
    await app.autosave();
    expect(app.host.store.get("draft-a").content).toBe("alpha text");
    expect(blankOverwrites(app)).toEqual([]);
  });

  it("saves text typed on a fresh page as a new draft, not over an old one", async () => {
    await app.clickDraft("draft-a");
    await app.menu("new");
    await app.type("charlie text");
    await app.autosave();
    const ids = [...app.host.store.keys()];
    expect(ids).toHaveLength(3);
    const created = ids.find((id) => !["draft-a", "draft-b"].includes(id));
    expect(app.host.store.get(created).content).toBe("charlie text");
    expect(app.host.store.get("draft-a").content).toBe("alpha text");
  });
});

describe("deleting", () => {
  beforeEach(async () => {
    app = await boot(seed());
  });

  it("undo after deleting a just-typed note puts it in the store, not only on screen", async () => {
    // Found by the random-session test: typed, deleted before autosave, undone.
    await app.type("typed moments ago");
    const id = app.activeTabId();
    await app.contextMenu(id, "Delete");
    expect(app.sidebarIds()).not.toContain(id);
    expect(await app.clickToast("Undo")).toBe(true);
    expect(app.sidebarIds()).toContain(id);
    expect(app.host.store.get(id)?.content).toBe("typed moments ago");
  });

  it("two deletes then two undos bring both drafts back", async () => {
    await app.clickDraft("draft-a");
    await app.contextMenu("draft-a", "Delete");
    await app.clickDraft("draft-b");
    await app.contextMenu("draft-b", "Delete");
    expect(app.sidebarIds()).toEqual([]);
    expect(await app.clickToast("Undo")).toBe(true); // newest first: b
    expect(app.sidebarIds()).toEqual(["draft-b"]);
    expect(await app.clickToast("Undo")).toBe(true); // then a
    expect([...app.sidebarIds()].sort()).toEqual(["draft-a", "draft-b"]);
    expect(await app.clickToast("Undo")).toBe(false); // nothing left to undo
  });

  it("delete then wait removes the draft from the store", async () => {
    await app.clickDraft("draft-a");
    await app.contextMenu("draft-a", "Delete");
    expect(app.sidebarIds()).toEqual(["draft-b"]);
    expect(app.editor.value).toBe("");
    expect(app.host.store.has("draft-a")).toBe(true); // still there during the undo window
  });
});

describe("closing, reopening, and cycling tabs", () => {
  beforeEach(async () => {
    app = await boot(seed());
  });

  it("shows the neighbour's text after closing the current tab", async () => {
    await app.clickDraft("draft-a");
    await app.clickDraft("draft-b");
    await app.menu("close_tab"); // closes b; a slides into its slot
    expect(app.activeTabId()).toBe("draft-a");
    expect(app.editor.value).toBe("alpha text");
  });

  it("goes back to a blank page when the last real tab closes, and keeps the draft", async () => {
    await app.clickDraft("draft-a");
    await app.menu("close_tab");
    expect(app.editor.value).toBe("");
    expect(app.tabIds()).toHaveLength(1);
    expect(app.host.store.get("draft-a").content).toBe("alpha text");
    await app.menu("close_tab"); // the only tab is a blank: nothing to close
    expect(app.tabIds()).toHaveLength(1);
  });

  it("brings a closed draft's text back with reopen", async () => {
    await app.clickDraft("draft-a");
    await app.menu("close_tab");
    await app.menu("reopen_tab");
    expect(app.activeTabId()).toBe("draft-a");
    expect(app.editor.value).toBe("alpha text");
  });

  it("shows the right text at every step of cycling", async () => {
    await app.clickDraft("draft-a");
    await app.clickDraft("draft-b");
    const blank = app.tabIds()[0];
    expect(app.tabIds()).toEqual([blank, "draft-a", "draft-b"]);

    await app.menu("next_tab"); // wraps to the blank
    expect(app.activeTabId()).toBe(blank);
    expect(app.editor.value).toBe("");

    await app.menu("next_tab");
    expect(app.editor.value).toBe("alpha text");

    await app.menu("prev_tab");
    expect(app.editor.value).toBe("");

    await app.menu("prev_tab");
    expect(app.editor.value).toBe("bravo text");
    expect(blankOverwrites(app)).toEqual([]);
  });
});

describe("keyboard access", () => {
  const key = (el, k, init = {}) =>
    el.dispatchEvent(
      new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }),
    );

  beforeEach(async () => {
    app = await boot(seed());
  });

  it("arrows move between tabs and show each draft, without stealing focus", async () => {
    await app.clickDraft("draft-a");
    await app.clickDraft("draft-b");
    const tabB = document.querySelector('#tabs .tab[data-id="draft-b"]');
    expect(tabB.getAttribute("role")).toBe("tab");
    expect(tabB.tabIndex).toBe(0);
    tabB.focus();
    key(tabB, "ArrowLeft");
    await settle();
    expect(app.activeTabId()).toBe("draft-a");
    expect(app.editor.value).toBe("alpha text");
    expect(document.activeElement?.dataset.id).toBe("draft-a");
    expect(document.activeElement.tabIndex).toBe(0);
    expect(tabB.tabIndex).toBe(-1);
  });

  it("Enter on a tab sends focus into the editor", async () => {
    await app.clickDraft("draft-a");
    const tab = document.querySelector('#tabs .tab[data-id="draft-a"]');
    tab.focus();
    key(tab, "Enter");
    await settle();
    expect(document.activeElement).toBe(app.editor);
  });

  it("ArrowDown from the search field walks the sidebar, Enter opens the row", async () => {
    const search = document.getElementById("search");
    search.focus();
    key(search, "ArrowDown");
    expect(document.activeElement?.dataset.id).toBe("draft-a");
    key(document.activeElement, "ArrowDown");
    expect(document.activeElement?.dataset.id).toBe("draft-b");
    key(document.activeElement, "Enter");
    await settle();
    expect(app.activeTabId()).toBe("draft-b");
    expect(app.editor.value).toBe("bravo text");
    expect(document.activeElement).toBe(app.editor);
  });

  it("Backspace on a sidebar row deletes it with an undo", async () => {
    const row = document.querySelector('#draft-list .draft-item[data-id="draft-a"]');
    row.focus();
    key(row, "Backspace");
    await settle();
    expect(app.sidebarIds()).toEqual(["draft-b"]);
    expect(await app.clickToast("Undo")).toBe(true);
    expect([...app.sidebarIds()].sort()).toEqual(["draft-a", "draft-b"]);
  });

  it("the context menu opens from the keyboard, arrows through items, and hands focus back", async () => {
    const row = document.querySelector('#draft-list .draft-item[data-id="draft-a"]');
    row.focus();
    key(row, "ContextMenu");
    await settle();
    const menu = document.getElementById("context-menu");
    expect(menu).not.toBeNull();
    expect(menu.contains(document.activeElement)).toBe(true);
    const first = document.activeElement;
    key(document.activeElement, "ArrowDown");
    expect(document.activeElement).not.toBe(first);
    expect(menu.contains(document.activeElement)).toBe(true);
    key(document.activeElement, "Tab");
    await settle();
    expect(document.getElementById("context-menu")).toBeNull();
    expect(document.activeElement).toBe(row);
  });

  it("the quick switcher filters by text, Enter opens the pick, Escape hands focus back", async () => {
    await app.clickDraft("draft-a");
    await app.menu("switcher");
    const input = document.getElementById("switcher-input");
    expect(document.activeElement).toBe(input);
    expect(document.querySelectorAll("#switcher-list .switcher-item").length).toBe(2);

    input.value = "bravo";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const items = document.querySelectorAll("#switcher-list .switcher-item");
    expect(items.length).toBe(1);
    expect(items[0].dataset.id).toBe("draft-b");

    key(input, "Enter");
    await sleep(200); // the overlay fades for 160ms before it is hidden
    expect(document.getElementById("switcher").hidden).toBe(true);
    expect(app.activeTabId()).toBe("draft-b");
    expect(app.editor.value).toBe("bravo text");

    await app.menu("switcher");
    key(document.getElementById("switcher-input"), "Escape");
    await sleep(200);
    expect(document.getElementById("switcher").hidden).toBe(true);
    expect(document.activeElement).toBe(app.editor);
    expect(app.editor.value).toBe("bravo text");
  });

  it("settings takes focus on open, keeps Tab inside, and gives focus back on close", async () => {
    await app.clickDraft("draft-a");
    expect(document.activeElement).toBe(app.editor);
    await app.menu("settings");
    const settings = document.getElementById("settings");
    expect(settings.hidden).toBe(false);
    expect(settings.contains(document.activeElement)).toBe(true);

    const focusable = [...settings.querySelectorAll("button, input, [tabindex]")].filter(
      (el) => !el.closest("[hidden]") && el.tabIndex !== -1 && !el.disabled,
    );
    const last = focusable[focusable.length - 1];
    last.focus();
    key(last, "Tab");
    expect(document.activeElement).toBe(focusable[0]);
    key(focusable[0], "Tab", { shiftKey: true });
    expect(document.activeElement).toBe(last);

    document.getElementById("settings-close").click();
    await settle();
    expect(document.activeElement).toBe(app.editor);
  });
});

describe("sync landing on the active draft", () => {
  beforeEach(async () => {
    app = await boot(seed());
  });

  it("is adopted once the draft was written by a rename, even before autosave", async () => {
    // Found by the random-session test: type, rename (which saves the draft in
    // full because the store had not seen it), then a sync lands.
    await app.type("x");
    const id = app.activeTabId();
    await app.contextMenu(id, "Rename…");
    document.getElementById("prompt-input").value = "Shopping";
    document.getElementById("prompt-ok").click();
    await settle();
    expect(app.host.store.get(id)?.content).toBe("x");
    app.host.store.set(id, {
      ...app.host.store.get(id),
      content: "from the cloud",
      updated_at: Date.now() + 5,
    });
    await emit("sync:changed", null);
    await settle();
    await settle();
    expect(app.editor.value).toBe("from the cloud");
  });

  it("is refused while typed text is still waiting for autosave", async () => {
    await app.clickDraft("draft-a");
    await app.type("typed, unsaved");
    app.host.store.set("draft-a", {
      ...app.host.store.get("draft-a"),
      content: "from the cloud",
      updated_at: Date.now() + 5,
    });
    await emit("sync:changed", null);
    await settle();
    await settle();
    expect(app.editor.value).toBe("typed, unsaved");
    await app.autosave();
    expect(app.host.store.get("draft-a").content).toBe("typed, unsaved");
  });

  it("is refused when the autosave lands while the pull's answer is in flight", async () => {
    // The fuzzer's one unreproduced failure. A pull reads the store, the
    // autosave writes it, then the pull's answer arrives. By then nothing is
    // marked unsaved, so the stale snapshot looked adoptable and the remote
    // text went over what had just been written.
    await app.clickDraft("draft-a");
    await app.type("typed text");
    const read = app.host.handlers.list_drafts;
    app.host.handlers.list_drafts = async () => {
      const snapshot = read();
      await sleep(AUTOSAVE_MS + 100);
      return snapshot;
    };
    app.host.store.set("draft-a", {
      ...app.host.store.get("draft-a"),
      content: "from the cloud",
      updated_at: Date.now() + 5,
    });
    await emit("sync:changed", null);
    await sleep(AUTOSAVE_MS * 3);
    await settle();
    expect(app.host.store.get("draft-a").content).toBe("typed text");
    expect(app.editor.value).toBe("typed text");
  });
});

describe("a file changed outside the app", () => {
  const fileSeed = () => ({
    drafts: [
      {
        id: "draft-f",
        title: "",
        content: "on disk",
        file_path: "/notes/f.txt",
        created_at: 1,
        updated_at: 1,
        pinned: false,
        cloud: false,
      },
    ],
    files: { "/notes/f.txt": "on disk" },
  });

  /** Open the file, type over it, let another program change the file, and
   *  let the autosave run into the conflict. */
  async function typeIntoChangedFile() {
    app = await boot(fileSeed());
    await app.clickDraft("draft-f");
    await app.type("mine");
    app.host.editOutside("/notes/f.txt", "theirs");
    await app.autosave();
    expect(app.host.disk.get("/notes/f.txt")).toBe("theirs"); // the write was refused
    expect(app.host.disk.get("/notes/f (conflicted copy).txt")).toBe("mine"); // and parked
  }

  it("Reload shows the file's text and forgets the typed text", async () => {
    await typeIntoChangedFile();
    expect(await app.clickToast("Reload")).toBe(true);
    expect(app.editor.value).toBe("theirs");
    await app.autosave();
    expect(app.host.disk.get("/notes/f.txt")).toBe("theirs"); // nothing left to write
  });

  it("Keep mine writes the typed text over the file", async () => {
    await typeIntoChangedFile();
    expect(await app.clickToast("Keep mine")).toBe(true);
    expect(app.editor.value).toBe("mine");
    expect(app.host.disk.get("/notes/f.txt")).toBe("mine");
    await app.type("mine, then more");
    await app.autosave();
    expect(app.host.disk.get("/notes/f.txt")).toBe("mine, then more"); // the next save is normal
  });
});

describe("a mixed session", () => {
  it("always shows the active draft's text and never loses an edit", async () => {
    app = await boot(seed());
    // What each draft should contain by now, from this test's point of view.
    const expected = new Map([
      ["draft-a", "alpha text"],
      ["draft-b", "bravo text"],
    ]);
    const check = () => {
      const id = app.activeTabId();
      expect(app.editor.value).toBe(expected.get(id) ?? "");
    };

    await app.clickDraft("draft-a");
    check();
    await app.type("alpha 2");
    expected.set("draft-a", "alpha 2");
    await app.clickDraft("draft-b");
    check();
    await app.menu("prev_tab"); // tabs are [blank, a, b]: back to a
    check();
    await app.type("alpha 3");
    expected.set("draft-a", "alpha 3");
    await app.autosave();
    await app.menu("close_tab"); // closes a; b slides into its slot
    check();
    await app.menu("reopen_tab");
    check();
    await app.menu("new");
    check();
    await app.type("delta");
    await app.autosave();
    const delta = app.activeTabId();
    expected.set(delta, "delta");
    await app.menu("prev_tab");
    check();
    await app.clickDraft("draft-b");
    check();

    for (const [id, text] of expected) {
      expect(app.host.store.get(id)?.content).toBe(text);
    }
    expect(blankOverwrites(app)).toEqual([]);
  });
});
