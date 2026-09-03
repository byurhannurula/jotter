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

/** What the page shows right now. */
export const page = () =>
  browser.execute(() => ({
    editor: document.getElementById("editor")?.value,
    tabs: [...document.querySelectorAll("#tabs .tab")].map((t) => t.textContent.trim()),
    activeTab: document.querySelector("#tabs .tab.active")?.textContent.trim() ?? null,
    rows: [...document.querySelectorAll("#draft-list .draft-item")].map((r) => r.dataset.id),
    toasts: [...document.querySelectorAll("#toast-host .toast")].map((t) => t.textContent.trim()),
    body: document.body.className,
    active: document.activeElement?.id || document.activeElement?.tagName,
  }));

/** Drive a native menu item by id through the E2E build's hook. WebDriver key
 *  events reach the page (the ⌃⌘F chord works) but reach the menu bar only
 *  sometimes (⌘B opened the sidebar in one run and not the next; ⌘W never
 *  closed a tab), so specs that need a menu item call it directly. */
export const menu = (id) => browser.execute((i) => window.__jotter.menu(i), id);

/** Open the first sidebar row's context menu and pick an entry by label. The
 *  menu is opened with a dispatched `contextmenu` event: a WebDriver
 *  right-click does not reach the page as one in WKWebView. */
export async function contextMenu(label) {
  const ok = await browser.execute((l) => {
    const row = document.querySelector("#draft-list .draft-item");
    if (!row) return "no row";
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 20 }));
    const item = [...document.querySelectorAll("#context-menu .context-item")].find(
      (b) => b.querySelector(".context-label")?.textContent === l,
    );
    if (!item) return "no entry";
    item.click();
    return "ok";
  }, label);
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
