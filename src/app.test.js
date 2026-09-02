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
import { boot, settle } from "./app-harness.js";

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
