// Test harness for booting the real main.js under happy-dom against a fake
// Rust host. Shared by app.test.js (scripted sessions) and app.random.test.js
// (random sessions with an oracle). Not a test file itself.
//
// The Rust side is stood in for with @tauri-apps/api/mocks: every invoke hits
// an in-memory store, and every listen can be fired with emit(). Nothing here
// touches a real disk.

import { vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";

// import.meta.url is not a file: URL under happy-dom, so resolve from the
// project root, which is where vitest runs.
const html = readFileSync(resolve(process.cwd(), "src/index.html"), "utf8");
const bodyHtml = html.slice(html.indexOf("<body"), html.indexOf("</body>"));
const bodyInner = bodyHtml.slice(bodyHtml.indexOf(">") + 1);

export const AUTOSAVE_MS = 400;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

/** Let the async chain behind a click or menu event finish. */
export async function settle() {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
  await nextFrame();
  await sleep(8);
}

/** In-memory stand-in for the Rust drafts store plus the few plugin commands
 *  init() touches. Records every save so a test can assert what hit disk. */
export function fakeHost({ drafts = [], files = {} } = {}) {
  const store = new Map(drafts.map((d) => [d.id, { ...d }]));
  const disk = new Map(Object.entries(files));
  const mtimes = new Map([...disk.keys()].map((p) => [p, 1000]));
  const saves = [];
  const deletes = [];

  const handlers = {
    init_store: () => [...store.values()].map((d) => ({ ...d })),
    list_drafts: () => [...store.values()].map((d) => ({ ...d })),
    save_draft: ({ draft }) => {
      // The Rust command refuses when the backing file changed underneath:
      // two known mtimes that differ. A null recorded mtime means "write
      // regardless" (Keep mine).
      if (draft.file_path && draft.file_mtime != null) {
        const now = mtimes.get(draft.file_path);
        if (now != null && now !== draft.file_mtime) throw "conflict";
      }
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
      deletes.push(id);
      store.delete(id);
    },
    read_text_file: ({ path }) => {
      if (!disk.has(path)) throw new Error(`no such file: ${path}`);
      return [disk.get(path), mtimes.get(path) ?? null];
    },
    write_conflict_copy: ({ path, contents }) => {
      const copy = path.replace(/(\.[^./]+)?$/, " (conflicted copy)$1");
      disk.set(copy, contents);
      return copy;
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

  /** Simulate another program writing the file: new text, new mtime. */
  const editOutside = (path, text) => {
    disk.set(path, text);
    mtimes.set(path, (mtimes.get(path) ?? 1000) + 1);
  };

  return { store, disk, mtimes, saves, deletes, editOutside };
}

/** Load a fresh main.js and run its init() against a fresh body.
 *
 *  Earlier instances from the same test file keep their document-level
 *  listeners and any pending timers, so: never dispatch keyboard events on
 *  `document` from a test (drive through menu events and element clicks
 *  instead), and give each boot draft ids no other boot uses, so a stray timer
 *  from an old instance cannot touch this one's store. */
export async function boot(hostOptions) {
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
  return {
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
    /** Right-click a sidebar row and pick a context-menu entry by label. */
    async contextMenu(id, label) {
      const li = document.querySelector(`#draft-list .draft-item[data-id="${id}"]`);
      if (!li) throw new Error(`draft ${id} is not in the sidebar`);
      li.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 }));
      await nextFrame();
      const item = [...document.querySelectorAll("#context-menu .context-item")].find(
        (b) => b.querySelector(".context-label")?.textContent === label,
      );
      if (!item) throw new Error(`no context-menu entry "${label}"`);
      item.click();
      await settle();
    },
    /** Click the newest toast action button with this label; false if none is
     *  up. Toasts stack oldest-first, so a person answering the one that just
     *  appeared clicks the last one. */
    async clickToast(label) {
      // A dismissed toast fades for 200 ms before it leaves the DOM; a person
      // cannot click that one, so neither does this.
      const btn = [...document.querySelectorAll("#toast-host .toast:not(.out) .toast-action")]
        .filter((b) => b.textContent === label)
        .pop();
      if (!btn) return false;
      btn.click();
      await settle();
      return true;
    },
  };
}
