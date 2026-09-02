// @vitest-environment happy-dom
//
// Boots the real main.js against a fake Rust host and drives it the way a user
// does: sidebar clicks, menu events, typing. The pure modules under lib/ have
// their own tests; this file covers the wiring between them and the DOM, which
// is where the "open a draft, editor stays blank, autosave writes the blank
// over the note" incident lived.
//
// The one rule every test here asserts: the editor shows the text of the draft
// whose tab is active, and nothing else is ever written to the store.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { mockIPC, mockWindows, clearMocks } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const bodyHtml = html.slice(html.indexOf("<body"), html.indexOf("</body>"));
const bodyInner = bodyHtml.slice(bodyHtml.indexOf(">") + 1);

const AUTOSAVE_MS = 400;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

/** In-memory stand-in for the Rust drafts store plus the few plugin commands
 *  init() touches. Records every save so a test can assert what hit disk. */
function fakeHost({ drafts = [], files = {} } = {}) {
  const store = new Map(drafts.map((d) => [d.id, { ...d }]));
  const disk = new Map(Object.entries(files));
  const mtimes = new Map([...disk.keys()].map((p) => [p, 1000]));
  const saves = [];

  const handlers = {
    init_store: () => [...store.values()].map((d) => ({ ...d })),
    list_drafts: () => [...store.values()].map((d) => ({ ...d })),
    save_draft: ({ draft }) => {
      saves.push({ id: draft.id, content: draft.content, file_path: draft.file_path });
      store.set(draft.id, { ...draft });
      if (draft.file_path) {
        disk.set(draft.file_path, draft.content);
        mtimes.set(draft.file_path, (mtimes.get(draft.file_path) ?? 1000) + 1);
        return mtimes.get(draft.file_path);
      }
      return null;
    },
    delete_draft: ({ id }) => {
      store.delete(id);
    },
    read_text_file: ({ path }) => {
      if (!disk.has(path)) throw new Error(`no such file: ${path}`);
      return [disk.get(path), mtimes.get(path) ?? null];
    },
    canonical_path: ({ path }) => path,
    take_opened_files: () => [],
    get_sync_config: () => ({ enabled: false, url: "", has_token: false }),
    synced_ids: () => [],
    refresh_shares: () => ({}),
    sync_now: () => undefined,
    get_drafts_dir: () => ["/Users/test/Library/Application Support/jotter/drafts", true, true],
    "plugin:path|resolve_directory": () => "/Users/test/",
    "plugin:updater|check": () => ({ available: false }),
  };

  mockWindows("main");
  mockIPC((cmd, args) => (cmd in handlers ? handlers[cmd](args ?? {}) : undefined), {
    shouldMockEvents: true,
  });

  return { store, disk, saves };
}

/** Load a fresh main.js and run its init() against a fresh body. */
async function boot(hostOptions) {
  const host = fakeHost(hostOptions);
  document.body.innerHTML = bodyInner;
  document.body.className = "sidebar-hidden";
  localStorage.clear();

  // main.js registers init on DOMContentLoaded. Capture it instead of letting
  // it attach, so an earlier test's instance is never re-run on this DOM.
  const realAdd = window.addEventListener.bind(window);
  let init = null;
  window.addEventListener = (type, fn, ...rest) => {
    if (type === "DOMContentLoaded") init = fn;
    else realAdd(type, fn, ...rest);
  };
  vi.resetModules();
  await import("./main.js");
  window.addEventListener = realAdd;
  await init();
  await nextFrame();

  const editor = document.getElementById("editor");
  const app = {
    host,
    editor,
    activeTabId: () => document.querySelector("#tabs .tab.active")?.dataset.id ?? null,
    tabIds: () => [...document.querySelectorAll("#tabs .tab")].map((t) => t.dataset.id),
    sidebarIds: () =>
      [...document.querySelectorAll("#draft-list .draft-item")].map((li) => li.dataset.id),
    async clickDraft(id) {
      const li = document.querySelector(`#draft-list .draft-item[data-id="${id}"]`);
      if (!li) throw new Error(`draft ${id} is not in the sidebar`);
      li.click();
      await settle();
    },
    async menu(id) {
      await emit("menu", id);
      await settle();
    },
    async type(text) {
      editor.value = text;
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      await nextFrame();
    },
    async autosave() {
      await sleep(AUTOSAVE_MS + 60);
    },
  };
  return app;
}

/** Let the async chain behind a click or menu event finish. */
async function settle() {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
  await nextFrame();
  await sleep(0);
}

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
    await app.menu("next_tab");
    check();
    await app.type("alpha 3");
    expected.set("draft-a", "alpha 3");
    await app.autosave();
    await app.menu("close_tab");
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
