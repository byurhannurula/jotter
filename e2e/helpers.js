import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { browser } from "@wdio/globals";

// DOM reads and clicks go through browser.execute: one round trip that
// returns JSON. Walking element handles from the test side ($$ + getText per
// element) was slow enough in WKWebView to blow the test timeout.

export const dataDir = () => process.env.JOTTER_DATA_DIR;

/** Every draft the store holds, straight from disk. */
export function storedDrafts() {
  const dir = join(dataDir(), "drafts");
  let names;
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  return names.map((n) => JSON.parse(readFileSync(join(dir, n), "utf8")));
}

/** The autosave debounce is 400ms; wait a little past it. */
export const AUTOSAVE_MS = 400;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const autosave = () => sleep(AUTOSAVE_MS + 300);

export const bodyHas = (cls) => browser.execute((c) => document.body.classList.contains(c), cls);

/** Draw the frame the UI is waiting on.
 *
 *  Tab titles and sidebar rows are written by `flushUi`, which the app schedules
 *  with requestAnimationFrame. WKWebView stops servicing those while the window
 *  is not in front, so a suite running beside someone else's work reads a page
 *  that is minutes behind what was typed — with everything written correctly to
 *  disk. Every read of that part of the page goes through here first. */
export const settle = () => browser.execute(() => window.__jotter?.flushUi?.());

/** What the page shows right now. */
export async function page() {
  await settle();
  return browser.execute(() => ({
    editor: document.getElementById("editor")?.value,
    tabs: [...document.querySelectorAll("#tabs .tab")].map((t) => t.textContent.trim()),
    activeTab: document.querySelector("#tabs .tab.active")?.textContent.trim() ?? null,
    rows: [...document.querySelectorAll("#draft-list .draft-item")].map((r) => r.dataset.id),
    toasts: [...document.querySelectorAll("#toast-host .toast")].map((t) => t.textContent.trim()),
    body: document.body.className,
    active: document.activeElement?.id || document.activeElement?.tagName,
  }));
}

/** Drive a native menu item by id through the E2E build's hook. WebDriver key
 *  events reach the page (the ⌃⌘F chord works) but reach the menu bar only
 *  sometimes (⌘B opened the sidebar in one run and not the next; ⌘W never
 *  closed a tab), so specs that need a menu item call it directly. */
export const menu = (id) => browser.execute((i) => window.__jotter.menu(i), id);

/** Open a sidebar row's context menu and pick an entry by label. Without `id`
 *  it uses the first row. The menu is opened with a dispatched `contextmenu`
 *  event: a WebDriver right-click does not reach the page as one in
 *  WKWebView. */
export async function contextMenu(label, id) {
  const ok = await browser.execute(
    (l, wanted) => {
      const row = wanted
        ? document.querySelector(`#draft-list .draft-item[data-id="${wanted}"]`)
        : document.querySelector("#draft-list .draft-item");
      if (!row) return "no row";
      row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 20 }));
      const item = [...document.querySelectorAll("#context-menu .context-item")].find(
        (b) => b.querySelector(".context-label")?.textContent === l,
      );
      if (!item) return "no entry";
      item.click();
      return "ok";
    },
    label,
    id ?? null,
  );
  if (ok !== "ok") throw new Error(`context menu "${label}": ${ok}`);
}

/** Wait for a toast whose message contains `text`. */
export function toastWith(text) {
  return browser.waitUntil(
    () =>
      browser.execute(
        (t) =>
          [...document.querySelectorAll("#toast-host .toast")].some((el) =>
            el.textContent.includes(t),
          ),
        text,
      ),
    { timeoutMsg: `no toast containing "${text}"` },
  );
}

/** Click the newest toast button with this label. */
export async function clickToast(label) {
  await browser.waitUntil(
    () =>
      browser.execute((l) => {
        const buttons = [
          ...document.querySelectorAll("#toast-host .toast:not(.out) .toast-action"),
        ];
        const btn = buttons.filter((b) => b.textContent === l).pop();
        if (!btn) return false;
        btn.click();
        return true;
      }, label),
    { timeoutMsg: `no toast button "${label}"` },
  );
}

/** Wait until the editor shows exactly this text. */
export function editorShows(text) {
  return browser.waitUntil(
    () => browser.execute((t) => document.getElementById("editor")?.value === t, text),
    { timeoutMsg: `editor never showed ${JSON.stringify(text)}` },
  );
}

/** Call a host command straight from the page, the way a script that got into
 *  the webview would. `main.js` is bypassed on purpose: the guard being tested
 *  lives in Rust, and going through the app's own code paths would only ever
 *  send paths the app already believes in.
 *
 *  The refusal comes back as `{ ok: false, err }`, never as a thrown error, so
 *  a spec can assert on it. Do not rename `err` to `error`: a returned object
 *  with an `error` key is the WebDriver wire shape for a failed command, and
 *  the driver turns it back into a thrown WebDriverError. */
export const hostInvoke = (command, args = {}) =>
  browser.execute(
    async (c, a) => {
      if (typeof window.__TAURI_INTERNALS__?.invoke !== "function") {
        return { ok: false, err: "no IPC bridge on the page" };
      }
      try {
        return { ok: true, value: await window.__TAURI_INTERNALS__.invoke(c, a) };
      } catch (e) {
        return { ok: false, err: String(e) };
      }
    },
    command,
    args,
  );

/** What the host refuses a path it never handed out. Kept in step with DENIED
 *  in `lib.rs`; `contracts.test.js` cannot see this file, so a change there has
 *  to be made here too. */
export const DENIED = "that file was not opened by the user";

/** Set an input's value and fire `input`, instead of typing key by key.
 *  Keystrokes into the find and prompt fields cost a round trip each in
 *  WKWebView; the page listens for `input`, so one dispatch is the same thing. */
export const fill = (selector, value) =>
  browser.execute(
    (sel, v) => {
      const node = document.querySelector(sel);
      if (!node) throw new Error(`no element ${sel}`);
      node.value = v;
      node.dispatchEvent(new Event("input", { bubbles: true }));
    },
    selector,
    value,
  );

/** The sidebar rows, in the order they are drawn. */
export async function rows() {
  await settle();
  return browser.execute(() =>
    [...document.querySelectorAll("#draft-list .draft-item")].map((r) => ({
      id: r.dataset.id,
      title: r.querySelector(".draft-title")?.textContent ?? "",
      pinned: r.classList.contains("pinned"),
      active: r.classList.contains("active"),
    })),
  );
}

/** The id of the draft the editor is showing. */
export async function currentId() {
  await settle();
  return browser.execute(
    () => document.querySelector("#draft-list .draft-item.active")?.dataset.id ?? null,
  );
}

/** Click through the page rather than the driver: WKWebView refuses a driver
 *  click on anything the layout has not settled, and every element here is one
 *  the app itself put on screen. */
export const click = (selector) =>
  browser.execute((sel) => {
    const node = document.querySelector(sel);
    if (!node) throw new Error(`no element ${sel}`);
    node.click();
  }, selector);

/** An element's trimmed text. */
export const text = (selector) =>
  browser.execute((sel) => document.querySelector(sel)?.textContent.trim() ?? null, selector);

/** Whether a modal (or any element) is hidden. */
export const isHidden = (selector) =>
  browser.execute((sel) => document.querySelector(sel)?.hidden ?? null, selector);
