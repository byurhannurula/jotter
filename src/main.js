import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { check as checkUpdate } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import MarkdownIt from "markdown-it";
import { baseName, draftTitle, draftPreview, isEmpty, relTime, findMatches } from "./lib/text.js";
import { APP } from "./lib/meta.js";
import { reconcileDrafts } from "./lib/sync-reconcile.js";
import {
  TOKEN_MASK,
  isTypedToken as isTypedTokenValue,
  tokenToSave,
  pillState,
  verifyResultToPill,
} from "./lib/sync-ui.js";

const md = new MarkdownIt({ html: false, linkify: true, typographer: true });

const AUTOSAVE_DELAY = 400; // ms after last keystroke
const TEXT_FILTERS = [
  { name: "Text", extensions: ["txt", "md", "markdown", "text", "log"] },
  { name: "All Files", extensions: ["*"] },
];

const appWindow = getCurrentWindow();

/** @type {Map<string, any>} id -> draft (all known drafts) */
const drafts = new Map();
/** @type {Map<string, HTMLElement>} id -> sidebar <li> */
const itemEls = new Map();
/** @type {string[]} ids of currently open tabs, left to right */
let openTabs = [];
let currentId = null;
let searchQuery = "";
/** @type {string[]} ids of recently-closed drafts, for ⇧⌘T */
const closedStack = [];
/** @type {Map<string, number>} id -> pending hard-delete timer (soft delete) */
const pendingDelete = new Map();

let editor;
let listEl;
let tabsEl;
let searchEl;
let saveTimer = null;
let uiRaf = 0;

// Find & replace state / elements
const find = { open: false, matches: [], idx: -1, caseSensitive: false };
let findbar, findInput, replaceInput, replaceRow, findCount, findCaseBtn;

// Markdown preview — per-tab: holds ids of tabs currently shown as preview
let previewEl;
const previewTabs = new Set();

// --- helpers -------------------------------------------------------------

function newId() {
  return crypto.randomUUID
    ? `draft-${crypto.randomUUID()}`
    : `draft-${Date.now()}-${Math.round(performance.now())}`;
}

// baseName / firstLine / draftTitle / draftPreview / relTime / isEmpty / findMatches
// live in ./lib/text.js (pure + unit-tested).

function fmtDate(ms) {
  if (!ms) return "—";
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function draftTooltip(d) {
  return `Created ${fmtDate(d.created_at)}\nEdited ${fmtDate(d.updated_at)}`;
}

/** A draft earns a place in the sidebar once it has real content. */
function isSaved(d) {
  return !isEmpty(d);
}

function orderedDrafts() {
  // Pinned drafts float to the top; within each group, most-recently-edited first.
  return [...drafts.values()].sort((a, b) => {
    if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
    return b.updated_at - a.updated_at;
  });
}

function matchesSearch(d) {
  if (!searchQuery) return true;
  return (
    draftTitle(d).toLowerCase().includes(searchQuery) ||
    d.content.toLowerCase().includes(searchQuery)
  );
}

function createBlankDraft() {
  const now = Date.now();
  const d = {
    id: newId(),
    title: "",
    content: "",
    file_path: null,
    created_at: now,
    updated_at: now,
    pinned: false,
  };
  drafts.set(d.id, d);
  return d;
}

// --- sidebar rendering ---------------------------------------------------

// Leading glyphs: a pencil for in-app drafts, a document for saved files.
// (Cloud / shared markers will slot into the sub-line later, behind their flags.)
const ICON_DRAFT = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 21h8"/><path d="m15 5 4 4"/><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/></svg>`;
const ICON_FILE = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>`;
const ICON_CLOSE = `<svg viewBox="5 5 14 14" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`;
// Plain cloud (not cloud-upload) — the sidebar "synced" marker.
const ICON_CLOUD_MARK = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg>`;
// Link — the sidebar "shared" marker.
const ICON_LINK = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`;
// Pin — the sidebar "pinned" marker (filled so it reads as a distinct state).
const ICON_PIN = `<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>`;

// Ids of drafts backed up to the cloud (drives the sidebar synced marker).
let syncedIds = new Set();
// draftId -> { shareId, url } for shared drafts (sidebar link marker + menu).
let sharedById = new Map();
// Whether a worker URL + token are configured (gates the sharing menu entries).
let cloudConfigured = false;

// Auto-sync scheduling: fire a sync a short while after edits settle, and back
// off retries while offline. All triggers just call sync_now; Rust serializes.
const SYNC_DEBOUNCE_MS = 15000;
let syncDebounceTimer = null;
let syncRetryTimer = null;
let syncFailures = 0;

function scheduleSync() {
  if (!cloudConfigured) return;
  clearTimeout(syncDebounceTimer);
  syncDebounceTimer = setTimeout(() => invoke("sync_now").catch(() => {}), SYNC_DEBOUNCE_MS);
}

/** Compact location for a file path: home → ~, and drop the filename. */
function fileDir(p) {
  const dir = p.replace(/[/\\][^/\\]*$/, "") || p;
  return dir.replace(/^(?:\/Users|\/home)\/[^/]+/, "~").replace(/^[A-Za-z]:\\Users\\[^\\]+/, "~");
}

/** Sidebar/switcher sub-line: a saved file always shows its folder; an in-app
 * draft shows its content preview. Consistent regardless of the content shape. */
function draftSubText(d) {
  if (d.file_path) return fileDir(d.file_path);
  return draftPreview(d) || "No additional text";
}

function makeItem(d) {
  const li = document.createElement("li");
  li.className = "draft-item" + (d.id === currentId ? " active" : "") + (d.pinned ? " pinned" : "");
  li.dataset.id = d.id;
  li.title = draftTooltip(d);

  const icon = document.createElement("span");
  icon.className = "draft-icon";
  icon.innerHTML = d.file_path ? ICON_FILE : ICON_DRAFT;

  const body = document.createElement("div");
  body.className = "draft-body";

  const title = document.createElement("div");
  title.className = "draft-title";
  title.textContent = draftTitle(d);

  const sub = document.createElement("div");
  sub.className = "draft-sub";
  const preview = document.createElement("span");
  preview.className = "preview";
  preview.textContent = draftSubText(d);
  sub.append(preview);
  body.append(title, sub);

  // Right column: status markers (top) over the timestamp (bottom).
  const aside = document.createElement("div");
  aside.className = "draft-aside";
  const marks = document.createElement("span");
  marks.className = "draft-marks";
  marks.innerHTML = draftMarksHtml(d.id);
  const time = document.createElement("span");
  time.className = "time";
  time.textContent = relTime(d.updated_at);
  aside.append(marks, time);

  li.append(icon, body, aside);
  li.addEventListener("click", () => openInTab(d.id));
  li.addEventListener("contextmenu", (e) => openDraftMenu(e, d.id));
  return li;
}

// The status-glyph markup for a row: pin (pinned) + cloud (synced) + link (shared).
// "" if none. Pin leads so the primary user-set state reads first.
function draftMarksHtml(id) {
  let html = "";
  if (drafts.get(id)?.pinned)
    html += `<span class="draft-mark pin" title="Pinned">${ICON_PIN}</span>`;
  if (syncedIds.has(id))
    html += `<span class="draft-mark" title="Synced to cloud">${ICON_CLOUD_MARK}</span>`;
  if (sharedById.has(id))
    html += `<span class="draft-mark" title="Shared — public link">${ICON_LINK}</span>`;
  return html;
}

// Reconcile the markers on already-rendered rows without a full re-render
// (avoids replaying the list entrance animation on every sync).
function applyDraftMarks() {
  for (const [id, li] of itemEls) {
    const marks = li.querySelector(".draft-marks");
    if (marks) marks.innerHTML = draftMarksHtml(id);
  }
}

// Pull the synced-ids set from Rust and repaint the markers. Cheap; safe when
// sync is unconfigured (returns an empty set).
async function refreshSyncedMarks() {
  try {
    const ids = await invoke("synced_ids");
    syncedIds = new Set(ids);
    applyDraftMarks();
  } catch {
    /* leave markers as-is */
  }
}

// Pull the live share registry from the worker into the local cache + markers.
async function refreshShares() {
  try {
    const map = await invoke("refresh_shares"); // { draftId: { shareId, url } }
    sharedById = new Map(Object.entries(map));
    applyDraftMarks();
  } catch {
    /* leave shares as-is */
  }
}

function renderList() {
  const scroll = listEl.scrollTop;
  itemEls.clear();
  listEl.replaceChildren();

  const items = orderedDrafts().filter((d) => isSaved(d) && matchesSearch(d));
  if (items.length === 0) {
    const empty = document.createElement("li");
    empty.className = "draft-empty";
    empty.textContent = searchQuery ? "No matching drafts" : "No saved drafts yet";
    listEl.append(empty);
    return;
  }
  for (const d of items) {
    const li = makeItem(d);
    itemEls.set(d.id, li);
    listEl.append(li);
  }
  listEl.scrollTop = scroll;
}

function refreshActiveItem() {
  const li = itemEls.get(currentId);
  const d = drafts.get(currentId);
  if (!d || !li) {
    renderList();
    return;
  }
  refreshItemInPlace(currentId);
  // Keep the edited draft at the top of *its* group: a pinned draft goes to the
  // very top; an unpinned one only rises to just below the last pinned row, so
  // editing it never lifts it above the pins.
  const anchor = d.pinned ? listEl.firstElementChild : firstUnpinnedRow();
  if (anchor === li) return; // already at the group top
  if (anchor) listEl.insertBefore(li, anchor);
  else listEl.append(li); // no unpinned rows yet — sits right after the pins
}

/** The first rendered row whose draft isn't pinned (top of the unpinned group). */
function firstUnpinnedRow() {
  for (const child of listEl.children) {
    if (!drafts.get(child.dataset.id)?.pinned) return child;
  }
  return null;
}

// --- tab rendering -------------------------------------------------------

function renderTabs() {
  tabsEl.replaceChildren();
  for (const id of openTabs) {
    const d = drafts.get(id);
    if (!d) continue;
    const tab = document.createElement("div");
    tab.className = "tab" + (id === currentId ? " active" : "");
    tab.dataset.id = id;

    const title = document.createElement("span");
    title.className = "tab-title";
    title.textContent = draftTitle(d);

    const close = document.createElement("button");
    close.className = "tab-close";
    close.innerHTML = ICON_CLOSE;
    close.title = "Close tab (⌘W)";
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(id);
    });

    tab.append(title, close);
    tab.addEventListener("click", () => activate(id));
    tab.addEventListener("contextmenu", (e) => openDraftMenu(e, id));
    tabsEl.append(tab);
  }
}

/** Re-render tabs + sidebar + window title together (used after any nav change). */
function renderAll() {
  renderTabs();
  renderList();
  updateWindowTitle();
  updateStatus();
}

/** Move the active highlight to `currentId` without rebuilding tabs/list. */
function setActiveHighlights() {
  for (const [id, li] of itemEls) {
    li.classList.toggle("active", id === currentId);
  }
  for (const tab of tabsEl.children) {
    tab.classList.toggle("active", tab.dataset.id === currentId);
  }
}

/** Update one sidebar row's title/preview/time in place (no reorder, no rebuild). */
function refreshItemInPlace(id) {
  const d = drafts.get(id);
  const li = itemEls.get(id);
  if (!d || !li) return;
  li.querySelector(".draft-title").textContent = draftTitle(d);
  li.querySelector(".preview").textContent = draftSubText(d);
  li.querySelector(".time").textContent = relTime(d.updated_at);
}

let lastWinTitle = "";

// Spellcheck on a very large textarea is the main typing-lag source in WebKit.
const SPELLCHECK_LIMIT = 20000;
function syncSpellcheck() {
  const d = drafts.get(currentId);
  const on = !!d && d.content.length < SPELLCHECK_LIMIT;
  if (editor.spellcheck !== on) editor.spellcheck = on;
}

function updateWindowTitle() {
  const d = drafts.get(currentId);
  const name = d ? draftTitle(d) : "Untitled";
  document.title = name;
  if (name !== lastWinTitle) {
    lastWinTitle = name;
    appWindow.setTitle(name).catch(() => {}); // avoid an IPC round-trip per keystroke
  }
  syncSpellcheck();
  applyView();
}

function focusEnd() {
  if (previewTabs.has(currentId)) return;
  editor.focus();
  const end = editor.value.length;
  editor.setSelectionRange(end, end);
}

// --- status bar ----------------------------------------------------------

let statusRaf = 0;
/** Coalesce caret-move status updates (keyup/click/select) to one frame. */
function queueStatus() {
  if (statusRaf) return;
  statusRaf = requestAnimationFrame(() => {
    statusRaf = 0;
    updateStatus();
  });
}

function updateStatus() {
  if (getSetting("statusbar") === "off") return;
  const posEl = document.getElementById("status-pos");
  const countEl = document.getElementById("status-count");
  if (!posEl || !countEl) return;

  // Use the model's copy (kept in sync by flushUi/applyEditorValue) rather than
  // re-reading the whole textarea value every frame.
  const d = drafts.get(currentId);
  const text = d ? d.content : "";
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const chars = text.length;
  countEl.textContent =
    `${words} ${words === 1 ? "word" : "words"} · ` + `${chars} ${chars === 1 ? "char" : "chars"}`;

  if (previewTabs.has(currentId)) {
    posEl.textContent = "Preview";
    return;
  }
  const caret = editor.selectionStart;
  const before = text.slice(0, caret);
  const line = before.split("\n").length;
  const col = caret - before.lastIndexOf("\n"); // 1-based (no newline → col 1)
  posEl.textContent = `Ln ${line}, Col ${col}`;
}

function refreshPreview() {
  if (!previewTabs.has(currentId) || !previewEl) return;
  const d = drafts.get(currentId);
  previewEl.innerHTML = md.render(d ? d.content : "");
}

/** Show editor or preview for whichever tab is active. */
function applyView() {
  const on = previewTabs.has(currentId);
  document.getElementById("preview-toggle").classList.toggle("active", on);
  editor.hidden = on;
  previewEl.hidden = !on;
  if (on) refreshPreview();
}

function togglePreview() {
  const on = !previewTabs.has(currentId);
  if (on) {
    previewTabs.add(currentId);
    if (find.open) closeFind();
  } else {
    previewTabs.delete(currentId);
  }
  applyView();
  updateStatus();
  if (on) previewEl.scrollTop = 0;
  else focusEnd();
}

// --- persistence ---------------------------------------------------------

async function persist() {
  const d = drafts.get(currentId);
  if (!d) return;
  d.content = editor.value; // pull the latest text at save time
  if (isEmpty(d)) return; // don't write empty untouched blanks
  try {
    await invoke("save_draft", { draft: d });
    scheduleSync(); // nudge a debounced cloud sync once edits settle
  } catch (err) {
    console.error("save_draft failed:", err);
  }
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, AUTOSAVE_DELAY);
}

async function flush() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (uiRaf) {
    cancelAnimationFrame(uiRaf);
    uiRaf = 0;
  }
  await persist();
}

// --- tab / draft actions -------------------------------------------------

async function activate(id) {
  if (id === currentId) {
    focusEnd();
    return;
  }
  await flush();
  const d = drafts.get(id);
  if (!d) return;
  // A draft backed by a real file reads from disk, so external edits show and a
  // vanished file is caught (and dropped from the sidebar) at open time.
  if (d.file_path) {
    try {
      d.content = await invoke("read_text_file", { path: d.file_path });
    } catch {
      showToast(`"${draftTitle(d)}" is no longer on disk`);
      removeDraftFromView(id);
      return;
    }
  }
  currentId = id;
  editor.value = d.content;
  // Switching doesn't change the list or tab set — just move the highlight,
  // so the sidebar/tabs don't rebuild and replay their entrance animation.
  setActiveHighlights();
  refreshItemInPlace(id); // the row's content may have changed (disk re-read)
  updateWindowTitle();
  updateStatus();
  focusEnd();
}

async function openInTab(id) {
  if (!drafts.has(id)) return;
  if (!openTabs.includes(id)) {
    openTabs.push(id);
    renderTabs(); // a genuinely new tab appears (and animates in)
  }
  await activate(id);
}

async function newTab() {
  await flush();
  const d = createBlankDraft();
  openTabs.push(d.id);
  currentId = d.id;
  editor.value = "";
  if (searchEl.value) {
    searchEl.value = "";
    searchQuery = "";
  }
  renderAll();
  focusEnd();
}

function pruneIfEmpty(id) {
  const d = drafts.get(id);
  if (d && isEmpty(d)) {
    drafts.delete(id);
    invoke("delete_draft", { id }).catch(() => {});
  }
}

async function closeTab(id) {
  const idx = openTabs.indexOf(id);
  if (idx === -1) return;
  const d = drafts.get(id);
  // Closing the last tab just spawns a fresh blank; if it's already an empty
  // blank there's nothing to close — leave it (avoids a pointless rebuild).
  if (openTabs.length === 1 && d && isEmpty(d)) return;

  const wasCurrent = id === currentId;
  if (wasCurrent) await flush();

  openTabs.splice(idx, 1);
  previewTabs.delete(id);
  // Remember meaningful drafts so ⇧⌘T can reopen them; blanks get pruned away.
  if (d && isSaved(d)) closedStack.push(id);
  pruneIfEmpty(id);

  if (openTabs.length === 0) {
    const nd = createBlankDraft();
    openTabs.push(nd.id);
    currentId = nd.id;
    editor.value = "";
    renderTabs(); // the fresh blank tab appears
  } else {
    if (wasCurrent) {
      const next = openTabs[Math.min(idx, openTabs.length - 1)];
      currentId = next;
      editor.value = drafts.get(next).content;
    }
    // Drop only the closed tab's element so the others don't re-animate.
    tabsEl.querySelector(`.tab[data-id="${CSS.escape(id)}"]`)?.remove();
  }
  // The sidebar list doesn't change on close — just move the highlight.
  setActiveHighlights();
  updateWindowTitle();
  updateStatus();
  focusEnd();
}

function cycleTab(dir) {
  if (openTabs.length < 2) return;
  const i = openTabs.indexOf(currentId);
  const n = (i + dir + openTabs.length) % openTabs.length;
  activate(openTabs[n]);
}

/** Reopen the most recently closed draft that still exists (⇧⌘T). */
function reopenClosedTab() {
  while (closedStack.length) {
    const id = closedStack.pop();
    if (drafts.has(id)) {
      openInTab(id);
      return;
    }
  }
}

/** Remove a draft from the in-memory model + UI (does not touch disk). */
function removeDraftFromView(id) {
  drafts.delete(id);
  previewTabs.delete(id);
  const ci = closedStack.indexOf(id);
  if (ci !== -1) closedStack.splice(ci, 1);
  const wasOpen = openTabs.includes(id);
  openTabs = openTabs.filter((t) => t !== id);

  if (currentId === id) {
    if (openTabs.length === 0) {
      const nd = createBlankDraft();
      openTabs.push(nd.id);
      currentId = nd.id;
      editor.value = "";
    } else {
      currentId = openTabs[openTabs.length - 1];
      editor.value = drafts.get(currentId).content;
    }
  }
  renderAll();
  if (wasOpen) focusEnd();
}

async function deleteDraft(id) {
  const d = drafts.get(id);
  if (!d) return;

  // Confirm mode: block on a native dialog, then remove from disk immediately.
  if (getSetting("del") === "confirm") {
    const confirmed = await ask(`Delete "${draftTitle(d)}"? This can't be undone.`, {
      title: "Delete draft",
      kind: "warning",
    });
    if (!confirmed) return;
    await invoke("delete_draft", { id }).catch((e) => console.error(e));
    revokeShareOnDelete(id); // a deleted note must not stay live at its public link
    removeDraftFromView(id);
    return;
  }

  // Undo mode: remove from view now, purge from disk after a grace period. The id
  // stays in pendingDelete until delete_draft actually resolves, so a sync can't
  // resurrect the draft in the gap between the timer firing and the file being gone.
  removeDraftFromView(id);
  const timer = setTimeout(async () => {
    try {
      await invoke("delete_draft", { id });
    } catch (e) {
      console.error(e);
    }
    pendingDelete.delete(id);
    revokeShareOnDelete(id); // now that the delete has committed, kill the link too
  }, 6000);
  pendingDelete.set(id, timer);
  showToast(`Deleted "${draftTitle(d)}"`, {
    actionLabel: "Undo",
    timeout: 6000,
    onAction: () => {
      const t = pendingDelete.get(id);
      if (t) clearTimeout(t);
      pendingDelete.delete(id);
      drafts.set(id, d); // file was never removed, so the model is enough
      renderList();
    },
  });
}

// Cheap per-keystroke handler. Heavy UI work is coalesced to one frame so that
// a burst of events (e.g. holding ⌘V) doesn't run it hundreds of times a second.
function onInput() {
  const d = drafts.get(currentId);
  if (!d) return;
  d.updated_at = Date.now();
  scheduleSave();
  if (!uiRaf) uiRaf = requestAnimationFrame(flushUi);
}

function flushUi() {
  uiRaf = 0;
  const d = drafts.get(currentId);
  if (!d) return;
  d.content = editor.value; // read the textarea once per frame, not per event

  const tabTitle = tabsEl.querySelector(`.tab[data-id="${CSS.escape(currentId)}"] .tab-title`);
  if (tabTitle) tabTitle.textContent = draftTitle(d);

  updateWindowTitle();
  updateStatus();
  if (searchQuery || !itemEls.has(currentId) || isEmpty(d)) renderList();
  else refreshActiveItem();

  if (find.open) {
    computeMatches();
    if (find.idx >= find.matches.length) find.idx = find.matches.length - 1;
    updateFindCount();
  }
}

async function openFile() {
  const selected = await openDialog({
    multiple: false,
    directory: false,
    filters: TEXT_FILTERS,
  });
  if (!selected) return;
  const path = typeof selected === "string" ? selected : selected.path;
  try {
    const content = await invoke("read_text_file", { path });
    await flush();
    const now = Date.now();
    const d = {
      id: newId(),
      title: "",
      content,
      file_path: path,
      created_at: now,
      updated_at: now,
      pinned: false,
    };
    drafts.set(d.id, d);
    openTabs.push(d.id);
    currentId = d.id;
    editor.value = content;
    renderTabs();
    renderList();
    updateWindowTitle();
    await persist();
    focusEnd();
  } catch (err) {
    console.error("open failed:", err);
  }
}

async function saveAs() {
  const d = drafts.get(currentId);
  if (!d) return;
  const path = await saveDialog({
    defaultPath: d.file_path ?? `${draftTitle(d)}.txt`,
    filters: TEXT_FILTERS,
  });
  if (!path) return;
  d.file_path = path;
  d.updated_at = Date.now();
  renderAll();
  await flush();
}

async function save() {
  const d = drafts.get(currentId);
  if (!d) return;
  if (!d.file_path) await saveAs();
  else await flush();
}

function toggleSidebar() {
  document.body.classList.toggle("sidebar-hidden");
}

// --- settings + about + toast --------------------------------------------

const FONTS = {
  system: "var(--editor-font)",
  serif: 'ui-serif, "New York", "Iowan Old Style", Palatino, Georgia, serif',
  mono: "var(--mono-font)",
  rounded: 'ui-rounded, "SF Pro Rounded", system-ui, sans-serif',
};

function applyTheme(v) {
  if (v === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = v;
}
function applyFont(v) {
  document.documentElement.style.setProperty("--editor-family", FONTS[v] || FONTS.system);
}
function applySize(v) {
  document.documentElement.style.setProperty("--editor-size", `${v}px`);
}
function applyWrap(v) {
  if (editor) editor.wrap = v === "off" ? "off" : "soft";
}
function applyMargins(v) {
  document.body.classList.toggle("margins-wide", v === "wide");
}
function applyStatusbar(v) {
  document.body.classList.toggle("no-statusbar", v === "off");
  updateStatus();
}
function applyPreviewBtn(v) {
  document.body.classList.toggle("no-preview-btn", v === "off");
}
// Delete behavior is read at delete time; nothing to apply on change.
function applyDelete() {}

// Each setting renders into its section. Control type is a segmented control
// ("seg", the default) or an on/off "toggle" switch.
const SETTINGS = {
  theme: {
    section: "general",
    label: "Appearance",
    def: "system",
    apply: applyTheme,
    options: [
      ["system", "System"],
      ["light", "Light"],
      ["dark", "Dark"],
    ],
  },
  del: {
    section: "general",
    label: "On delete",
    def: "undo",
    apply: applyDelete,
    options: [
      ["undo", "Undo toast"],
      ["confirm", "Confirm"],
    ],
  },
  previewBtn: {
    section: "general",
    label: "Preview button",
    def: "on",
    apply: applyPreviewBtn,
    control: "toggle",
  },
  font: {
    section: "editor",
    label: "Font",
    def: "system",
    apply: applyFont,
    options: [
      ["system", "System"],
      ["serif", "Serif"],
      ["mono", "Mono"],
      ["rounded", "Rounded"],
    ],
  },
  size: {
    section: "editor",
    label: "Text size",
    def: "15.5",
    apply: applySize,
    options: [
      ["14", "Small"],
      ["15.5", "Medium"],
      ["17", "Large"],
    ],
  },
  wrap: {
    section: "editor",
    label: "Word wrap",
    def: "on",
    apply: applyWrap,
    options: [
      ["on", "On"],
      ["off", "Off"],
    ],
  },
  margins: {
    section: "editor",
    label: "Margins",
    def: "cozy",
    apply: applyMargins,
    options: [
      ["cozy", "Cozy"],
      ["wide", "Wide"],
    ],
  },
  statusbar: {
    section: "editor",
    label: "Status bar",
    def: "on",
    apply: applyStatusbar,
    control: "toggle",
  },
};

const SHORTCUTS = [
  [
    "File",
    [
      ["⌘N / ⌘T", "New tab"],
      ["⌘O", "Open file"],
      ["⌘P", "Quick open"],
      ["⌘S / ⇧⌘S", "Save / Save As"],
      ["⌘W", "Close tab"],
      ["⇧⌘T", "Reopen closed tab"],
    ],
  ],
  [
    "Edit",
    [
      ["⌘Z / ⇧⌘Z", "Undo / Redo"],
      ["⌘F", "Find"],
      ["⌘G / ⇧⌘G", "Find next / previous"],
    ],
  ],
  [
    "View",
    [
      ["⌘B", "Toggle sidebar"],
      ["⇧⌘P", "Toggle markdown preview"],
      ["⌘,", "Settings"],
    ],
  ],
  [
    "Draft",
    [
      ["⌃⌘P", "Pin / unpin"],
      ["⇧⌘L", "Share / copy link"],
      ["⇧⌘E", "Export"],
      ["⌘⌫", "Delete"],
    ],
  ],
  ["Tabs", [["⌃Tab / ⌃⇧Tab", "Next / previous tab"]]],
];

let eggClicks = 0;

function getSetting(name) {
  return localStorage.getItem(`set-${name}`) ?? SETTINGS[name].def;
}
function setSetting(name, val) {
  localStorage.setItem(`set-${name}`, val);
  SETTINGS[name].apply(val);
  markControl(name, val);
}
function markControl(name, val) {
  const el = document.getElementById(`set-${name}`);
  if (!el) return;
  if (SETTINGS[name].control === "toggle") {
    const on = String(val) === "on";
    el.classList.toggle("on", on);
    el.setAttribute("aria-checked", on ? "true" : "false");
  } else {
    for (const btn of el.querySelectorAll("button")) {
      btn.classList.toggle("active", btn.dataset.val === String(val));
    }
  }
}
function applyAllSettings() {
  for (const name of Object.keys(SETTINGS)) SETTINGS[name].apply(getSetting(name));
}

function sectionEl(section) {
  return document.querySelector(`.settings-section[data-section="${section}"]`);
}

function settingRow(name) {
  const cfg = SETTINGS[name];
  const row = document.createElement("div");
  row.className = "setting-row";
  const label = document.createElement("span");
  label.className = "setting-label";
  label.textContent = cfg.label;
  row.append(label);

  if (cfg.control === "toggle") {
    const sw = document.createElement("button");
    sw.className = "switch interactive";
    sw.id = `set-${name}`;
    sw.setAttribute("role", "switch");
    sw.addEventListener("click", () => setSetting(name, getSetting(name) === "on" ? "off" : "on"));
    row.append(sw);
  } else {
    const seg = document.createElement("div");
    seg.className = "seg";
    seg.id = `set-${name}`;
    for (const [val, text] of cfg.options) {
      const b = document.createElement("button");
      b.dataset.val = val;
      b.textContent = text;
      b.addEventListener("click", () => setSetting(name, val));
      seg.append(b);
    }
    row.append(seg);
  }
  return row;
}

// Grouped-card building blocks (macOS-settings style).
function groupTitle(text) {
  const el = document.createElement("div");
  el.className = "settings-group-title";
  el.textContent = text;
  return el;
}
function groupCard() {
  const el = document.createElement("div");
  el.className = "settings-group";
  return el;
}
function groupRow() {
  const el = document.createElement("div");
  el.className = "group-row";
  return el;
}
function rowLabel(text) {
  const el = document.createElement("span");
  el.className = "group-label";
  el.textContent = text;
  return el;
}

function renderShortcutsSection() {
  const host = sectionEl("shortcuts");
  host.replaceChildren();
  for (const [group, rows] of SHORTCUTS) {
    const h = document.createElement("div");
    h.className = "shortcut-group";
    h.textContent = group;
    host.append(h);
    for (const [keys, action] of rows) {
      const r = document.createElement("div");
      r.className = "shortcut-row";
      r.innerHTML = `<span class="shortcut-action"></span><kbd class="shortcut-keys"></kbd>`;
      r.querySelector(".shortcut-action").textContent = action;
      r.querySelector(".shortcut-keys").textContent = keys;
      host.append(r);
    }
  }
}

// --- auto-update ---------------------------------------------------------
// Inert until the app is configured with a real signer public key + signed
// release artifacts; until then check() just errors and we fail quietly.

function autoUpdateOn() {
  return localStorage.getItem("set-autoupdate") !== "off"; // default on
}

let updateChecking = false;

async function checkForUpdates({ silent = false } = {}) {
  if (updateChecking) return;
  updateChecking = true;
  try {
    const update = await checkUpdate();
    if (update) {
      showToast(`Update ${update.version} available`, {
        actionLabel: "Update & Relaunch",
        timeout: 12000,
        onAction: () => installUpdate(update),
      });
    } else if (!silent) {
      showToast("You're on the latest version");
    }
  } catch (err) {
    console.error("update check failed:", err);
    if (!silent) showToast("Couldn't check for updates");
  } finally {
    updateChecking = false;
  }
}

async function installUpdate(update) {
  const done = showToast("Downloading update…", { timeout: 600000 });
  try {
    await update.downloadAndInstall();
    done();
    await relaunch();
  } catch (err) {
    done();
    console.error("update install failed:", err);
    showToast("Update failed");
  }
}

// About + Updates + Credits in one section (grouped cards).
function renderAboutSection() {
  const host = sectionEl("about");
  host.replaceChildren();

  const hero = document.createElement("div");
  hero.className = "about-hero";
  hero.innerHTML = `
    <button class="about-icon" id="about-icon" aria-label="${APP.name}">
      <svg viewBox="0 0 64 64" width="54" height="54" aria-hidden="true">
        <rect x="12" y="8" width="40" height="48" rx="7" fill="var(--accent)"/>
        <rect x="12" y="8" width="40" height="13" rx="7" fill="var(--accent-hi)"/>
        <g stroke="rgba(255,255,255,0.92)" stroke-width="3" stroke-linecap="round">
          <path d="M21 32h22"/><path d="M21 40h22"/><path d="M21 48h13"/>
        </g>
      </svg>
    </button>
    <div class="about-hero-text">
      <div class="about-hero-name">${APP.name}</div>
      <div class="about-hero-ver">Version ${APP.version}</div>
      <div class="about-hero-desc">${APP.tagline}</div>
    </div>`;
  host.append(hero);

  // Updates group
  host.append(groupTitle("Updates"));
  const updates = groupCard();

  const autoRow = groupRow();
  autoRow.append(rowLabel("Automatically check for updates"));
  const toggle = document.createElement("button");
  toggle.className = "switch interactive";
  toggle.setAttribute("role", "switch");
  const syncToggle = () => {
    const on = autoUpdateOn();
    toggle.classList.toggle("on", on);
    toggle.setAttribute("aria-checked", on ? "true" : "false");
  };
  toggle.addEventListener("click", () => {
    localStorage.setItem("set-autoupdate", autoUpdateOn() ? "off" : "on");
    syncToggle();
  });
  syncToggle();
  autoRow.append(toggle);

  const checkRow = groupRow();
  const checkBtn = document.createElement("button");
  checkBtn.className = "group-link";
  checkBtn.textContent = "Check for updates…";
  checkBtn.addEventListener("click", () => checkForUpdates());
  checkRow.append(checkBtn);

  updates.append(autoRow, checkRow);
  host.append(updates);

  // Credits group
  host.append(groupTitle("Credits"));
  const credits = groupCard();
  const byRow = groupRow();
  byRow.append(rowLabel(`Built by ${APP.author}`));
  credits.append(byRow);
  for (const { label, url } of APP.links) {
    const link = document.createElement("button");
    link.className = "group-link";
    link.textContent = label;
    link.addEventListener("click", () => openUrl(url).catch(() => {}));
    const row = groupRow();
    row.append(link);
    credits.append(row);
  }
  host.append(credits);

  // Easter egg: 5 clicks on the icon.
  const icon = hero.querySelector("#about-icon");
  icon.addEventListener("click", () => {
    icon.classList.remove("egg");
    void icon.offsetWidth;
    icon.classList.add("egg");
    if (++eggClicks >= 5) {
      eggClicks = 0;
      showToast(
        "You found the quiet room — made for thoughts that couldn't wait. ↳ keep writing.",
        { timeout: 7000 },
      );
    }
  });
}

// --- Sync settings (self-hosted cloud) -----------------------------------
// Bespoke (not the SETTINGS/localStorage registry) so the auth token stays in
// Rust (sync.json) and never touches the webview's localStorage. Reads/writes go
// through get_sync_config / set_sync_config; the token is fetched (get_sync_token)
// only on explicit reveal/copy.

let refreshSyncSection = () => {};

// Refresh whether cloud is configured; toggles the sidebar Sync button and gates
// the sharing menu entries.
async function refreshSyncChrome() {
  const btn = document.getElementById("sidebar-sync");
  try {
    const cfg = await invoke("get_sync_config");
    cloudConfigured = !!(cfg.url && cfg.has_token);
  } catch {
    cloudConfigured = false;
  }
  if (btn) btn.hidden = !cloudConfigured;
}

function genSyncToken() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

const EYE_SVG = `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 8s2.4-4.3 6.5-4.3S14.5 8 14.5 8 12.1 12.3 8 12.3 1.5 8 1.5 8Z"/><circle cx="8" cy="8" r="1.8"/></svg>`;
const CLOUD_UPLOAD_PATHS = `<path d="M12 13v8"/><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="m8 17 4-4 4 4"/>`;
const CLOUD_SVG = `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${CLOUD_UPLOAD_PATHS}</svg>`;
const COPY_SVG = `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H3.5A1.5 1.5 0 0 0 2 4v5.5A1.5 1.5 0 0 0 3.5 11H5"/></svg>`;
const REFRESH_SVG = `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.7"/><path d="M13.4 2.4V5h-2.6"/></svg>`;
const CHECK_SVG = `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8.5l3.2 3.2L13 4.8"/></svg>`;
const STATUS_CLOUD_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${CLOUD_UPLOAD_PATHS}</svg>`;

// Global sync indicator in the editor status bar. Shown only once sync actually
// runs (sync:status only fires when configured + enabled).
function setSyncBar(text, kind, title) {
  const el = document.getElementById("status-sync");
  if (!el) return;
  el.hidden = false;
  el.className = "status-seg status-sync" + (kind ? " " + kind : "");
  el.innerHTML = STATUS_CLOUD_SVG + '<span class="ssync-label"></span>';
  el.querySelector(".ssync-label").textContent = text;
  if (title) el.title = title;
}

function renderSyncSection() {
  const host = sectionEl("sync");
  host.replaceChildren();

  // Header: title + status pill
  const header = document.createElement("div");
  header.className = "sync-header";
  const title = document.createElement("div");
  title.className = "sync-header-title";
  title.textContent = "Cloud";
  const pill = document.createElement("span");
  pill.className = "sync-pill";
  header.append(title, pill);
  host.append(header);

  // Connection card
  host.append(groupTitle("Connection"));
  const conn = groupCard();

  // Worker URL
  const urlRow = groupRow();
  urlRow.classList.add("sync-row");
  urlRow.append(rowLabel("Worker URL"));
  const urlInput = document.createElement("input");
  urlInput.className = "prompt-input sync-input";
  urlInput.type = "url";
  urlInput.placeholder = "https://…workers.dev";
  urlInput.spellcheck = false;
  urlRow.append(urlInput);
  conn.append(urlRow);

  // Auth token + reveal eye
  const tokenRow = groupRow();
  tokenRow.classList.add("sync-row");
  tokenRow.append(rowLabel("Auth token"));
  const tokenWrap = document.createElement("div");
  tokenWrap.className = "sync-token-wrap";
  const tokenInput = document.createElement("input");
  tokenInput.className = "prompt-input sync-input";
  tokenInput.type = "password";
  tokenInput.placeholder = "paste or generate";
  tokenInput.autocomplete = "off";
  tokenInput.spellcheck = false;
  const eyeBtn = document.createElement("button");
  eyeBtn.className = "sync-eye";
  eyeBtn.type = "button";
  eyeBtn.title = "Show token";
  eyeBtn.setAttribute("aria-label", "Show token");
  eyeBtn.innerHTML = EYE_SVG;
  tokenWrap.append(tokenInput, eyeBtn);
  tokenRow.append(tokenWrap);
  conn.append(tokenRow);

  // Actions: Copy token / Regenerate (left) — Verify Connection (right)
  const actionsRow = groupRow();
  actionsRow.className = "group-row sync-actions-row";
  const leftActions = document.createElement("div");
  leftActions.className = "sync-actions";
  const copyBtn = document.createElement("button");
  copyBtn.className = "prompt-btn sync-btn";
  copyBtn.innerHTML = `${COPY_SVG}<span>Copy</span>`;
  const genBtn = document.createElement("button");
  genBtn.className = "prompt-btn sync-btn";
  genBtn.innerHTML = `${REFRESH_SVG}<span>Regenerate</span>`;
  leftActions.append(copyBtn, genBtn);
  const verifyBtn = document.createElement("button");
  verifyBtn.className = "prompt-btn primary sync-btn";
  verifyBtn.innerHTML = `${CHECK_SVG}<span>Verify Connection</span>`;
  actionsRow.append(leftActions, verifyBtn);
  conn.append(actionsRow);
  host.append(conn);

  const help = document.createElement("p");
  help.className = "sync-help";
  help.textContent =
    "Paste this token as the worker's SYNC_TOKEN secret when you deploy to Cloudflare. It's the only thing protecting your notes — treat it like a password.";
  host.append(help);

  // Setup Guide
  const guideHead = document.createElement("div");
  guideHead.className = "sync-guide-head";
  guideHead.append(groupTitle("Setup Guide"));
  const ghLink = document.createElement("button");
  ghLink.className = "group-link";
  ghLink.textContent = "View on GitHub";
  ghLink.addEventListener("click", () => openUrl(APP.worker.repoUrl).catch(() => {}));
  guideHead.append(ghLink);
  host.append(guideHead);

  const deployBtn = document.createElement("button");
  deployBtn.className = "sync-deploy";
  deployBtn.innerHTML = `${CLOUD_SVG}<span>Deploy to Cloudflare</span>`;
  deployBtn.addEventListener("click", () => openUrl(APP.worker.deployUrl).catch(() => {}));
  host.append(deployBtn);

  const steps = document.createElement("details");
  steps.className = "sync-steps";
  const summary = document.createElement("summary");
  summary.textContent = "Setup steps";
  steps.append(summary);
  const ol = document.createElement("ol");
  for (const t of [
    "Generate a token above and copy it — you'll paste it into Cloudflare next.",
    'Click "Deploy to Cloudflare". It clones the worker, provisions R2 + D1, and asks for the SYNC_TOKEN secret — paste the token you copied.',
    'Paste your worker URL above, then click "Verify Connection" to finish and confirm.',
  ]) {
    const li = document.createElement("li");
    li.textContent = t;
    ol.append(li);
  }
  steps.append(ol);
  host.append(steps);

  // --- state + behavior ---
  let hasToken = false;
  let verifiedOk = false;

  // Whether the field holds a real user-entered token (not the masked dots).
  const isTypedToken = () => isTypedTokenValue(tokenInput.value);

  function setPill(text, kind) {
    if (text !== undefined) {
      pill.textContent = text;
      pill.className = "sync-pill" + (kind ? " " + kind : "");
      return;
    }
    const { label, kind: k } = pillState({
      url: urlInput.value,
      hasToken,
      typedToken: isTypedToken(),
      verifiedOk,
    });
    setPill(label, k);
  }

  function updateEnabled() {
    const hasTok = hasToken || isTypedToken();
    const configured = !!urlInput.value.trim() && hasTok;
    verifyBtn.disabled = !configured;
    copyBtn.disabled = !hasTok;
  }

  // The raw token: the field if the user typed/generated one, else fetched from
  // Rust on demand (reveal / copy only).
  async function currentToken() {
    if (isTypedToken()) return tokenInput.value.trim();
    if (hasToken) {
      try {
        return await invoke("get_sync_token");
      } catch {
        return "";
      }
    }
    return "";
  }

  // Solid masked dots stand in for a stored token so the field isn't empty;
  // cleared on focus so the user can type a new one.
  function showMask() {
    if (hasToken && !isTypedToken()) {
      tokenInput.type = "password";
      tokenInput.value = TOKEN_MASK;
      eyeBtn.classList.remove("on");
    }
  }

  // Persist current fields. A blank/masked token sends null so Rust keeps the
  // stored token (URL edits never wipe it).
  async function save() {
    const token = tokenToSave(tokenInput.value);
    await invoke("set_sync_config", {
      enabled: true,
      url: urlInput.value.trim(),
      token,
    });
    if (token) hasToken = true;
  }

  tokenInput.addEventListener("focus", () => {
    if (tokenInput.value === TOKEN_MASK) tokenInput.value = "";
  });
  tokenInput.addEventListener("blur", () => {
    if (!isTypedToken()) showMask();
  });

  const dirty = () => {
    verifiedOk = false;
    updateEnabled();
    setPill();
  };
  urlInput.addEventListener("input", dirty);
  tokenInput.addEventListener("input", dirty);

  genBtn.addEventListener("click", () => {
    const token = genSyncToken();
    tokenInput.type = "text"; // reveal so the user can copy it into the worker secret
    tokenInput.value = token;
    eyeBtn.classList.add("on");
    dirty();
    copyText(token, "Token copied — paste it into the worker's SYNC_TOKEN secret");
  });

  copyBtn.addEventListener("click", async () => {
    const t = await currentToken();
    if (t) copyText(t, "Token copied");
  });

  eyeBtn.addEventListener("click", async () => {
    if (tokenInput.type === "password") {
      tokenInput.value = await currentToken();
      tokenInput.type = "text";
      eyeBtn.classList.add("on");
    } else {
      tokenInput.type = "password";
      eyeBtn.classList.remove("on");
      if (!isTypedToken()) showMask();
    }
  });

  verifyBtn.addEventListener("click", async () => {
    verifyBtn.disabled = true;
    setPill("Verifying…", "");
    try {
      await save(); // save first; the test reads the stored url + token in Rust
      const r = await invoke("sync_test_connection");
      if (r.ok) verifiedOk = true;
      const { label, kind } = verifyResultToPill(r);
      setPill(label, kind);
    } catch {
      setPill("Unreachable", "err"); // transport failure (DNS/timeout/TLS)
    } finally {
      updateEnabled();
      refreshSyncChrome(); // config may have changed -> update the sidebar button
    }
  });

  async function populate() {
    try {
      const cfg = await invoke("get_sync_config");
      urlInput.value = cfg.url || "";
      hasToken = !!cfg.has_token;
      tokenInput.value = "";
      tokenInput.type = "password";
      tokenInput.placeholder = "paste or generate";
      showMask(); // solid dots stand in for a stored token
      verifiedOk = false;
      updateEnabled();
      setPill();
    } catch (e) {
      console.error("get_sync_config failed:", e);
    }
  }

  refreshSyncSection = populate;
  populate();
}

// After a sync lands changes on disk, reconcile the in-memory model without
// clobbering what the user is actively editing. Conservative on deletes: only
// drops pure in-app drafts (no file_path) that vanished from the store.
async function refreshFromSync() {
  let list;
  try {
    list = await invoke("list_drafts");
  } catch {
    return;
  }
  // A soft-deleted draft is gone from the model but its file lingers on disk for
  // the ~6s undo grace window. Without this, a sync landing in that window sees the
  // still-present file as a "new" draft and re-adds it — the note flashes back, then
  // vanishes on the next sync once the tombstone lands. Skip anything mid-delete.
  if (pendingDelete.size) list = list.filter((d) => !pendingDelete.has(d.id));
  const { updates, removals, editorContent } = reconcileDrafts(
    list,
    drafts,
    currentId,
    editor.value,
  );
  for (const upd of updates) drafts.set(upd.id, upd);
  if (editorContent !== null) editor.value = editorContent;
  for (const id of removals) removeDraftFromView(id);
  renderAll();
}

function showSection(name) {
  for (const s of document.querySelectorAll(".settings-section")) {
    s.hidden = s.dataset.section !== name;
  }
  for (const r of document.querySelectorAll(".rail-item")) {
    r.classList.toggle("active", r.dataset.section === name);
  }
}

function openSettings(section = "general") {
  openModal("settings");
  showSection(section);
  if (section === "sync") refreshSyncSection();
}

function initSettings() {
  const cards = {};
  for (const name of Object.keys(SETTINGS)) {
    const sec = SETTINGS[name].section;
    if (!cards[sec]) {
      cards[sec] = groupCard();
      sectionEl(sec).append(cards[sec]);
    }
    cards[sec].append(settingRow(name));
    markControl(name, getSetting(name));
  }
  renderShortcutsSection();
  renderSyncSection();
  renderAboutSection();
  showSection("general");
  for (const r of document.querySelectorAll(".rail-item")) {
    r.addEventListener("click", () => showSection(r.dataset.section));
  }
  document.getElementById("settings-close").addEventListener("click", () => closeModal("settings"));
}

/** Transient bottom-center message with an optional action button. */
function showToast(message, { actionLabel, onAction, timeout = 5000 } = {}) {
  const host = document.getElementById("toast-host");
  const toast = document.createElement("div");
  toast.className = "toast";
  const msg = document.createElement("span");
  msg.className = "toast-msg";
  msg.textContent = message;
  toast.append(msg);
  let timer;
  const dismiss = () => {
    clearTimeout(timer);
    toast.classList.add("out");
    setTimeout(() => toast.remove(), 200);
  };
  if (actionLabel) {
    const act = document.createElement("button");
    act.className = "toast-action";
    act.textContent = actionLabel;
    act.addEventListener("click", () => {
      onAction?.();
      dismiss();
    });
    toast.append(act);
  }
  host.append(toast);
  timer = setTimeout(dismiss, timeout);
  return dismiss;
}

// --- context menu + draft actions ----------------------------------------

let ctxCleanup = null;

function closeContextMenu() {
  document.getElementById("context-menu")?.remove();
  if (ctxCleanup) {
    ctxCleanup();
    ctxCleanup = null;
  }
}

/** Show a small menu at (x, y). `items` = {label, action, disabled} or {separator}. */
function showContextMenu(x, y, items) {
  closeContextMenu();
  const menu = document.createElement("div");
  menu.id = "context-menu";
  menu.className = "context-menu";
  let i = 0;
  for (const it of items) {
    if (it.separator) {
      const sep = document.createElement("div");
      sep.className = "context-sep";
      menu.append(sep);
      continue;
    }
    const b = document.createElement("button");
    b.className = "context-item" + (it.disabled ? " disabled" : "");
    const label = document.createElement("span");
    label.className = "context-label";
    label.textContent = it.label;
    b.append(label);
    if (it.accel) {
      const kbd = document.createElement("span");
      kbd.className = "context-accel";
      kbd.textContent = it.accel;
      b.append(kbd);
    }
    b.style.animationDelay = `${i++ * 18}ms`; // gentle stagger on open
    if (!it.disabled) {
      b.addEventListener("click", () => {
        closeContextMenu();
        it.action();
      });
    }
    menu.append(b);
  }
  document.body.append(menu);

  // Clamp to the viewport.
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 6))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 6))}px`;

  const onDown = (e) => {
    if (!menu.contains(e.target)) closeContextMenu();
  };
  const onKey = (e) => {
    if (e.key === "Escape") closeContextMenu();
  };
  const onGone = () => closeContextMenu();
  // Defer so the opening right-click doesn't immediately dismiss it.
  requestAnimationFrame(() => document.addEventListener("mousedown", onDown));
  document.addEventListener("keydown", onKey);
  window.addEventListener("blur", onGone);
  window.addEventListener("resize", onGone);
  document.addEventListener("scroll", onGone, true);
  ctxCleanup = () => {
    document.removeEventListener("mousedown", onDown);
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("blur", onGone);
    window.removeEventListener("resize", onGone);
    document.removeEventListener("scroll", onGone, true);
  };
}

/** A tiny one-field prompt modal. Resolves to the trimmed value, or null on cancel. */
function promptText({ title = "Rename", value = "", okLabel = "Save" } = {}) {
  return new Promise((resolve) => {
    const box = document.getElementById("prompt");
    const input = document.getElementById("prompt-input");
    const okBtn = document.getElementById("prompt-ok");
    const cancelBtn = document.getElementById("prompt-cancel");
    document.getElementById("prompt-title").textContent = title;
    okBtn.textContent = okLabel;
    input.value = value;
    openModal("prompt");
    input.focus();
    input.select();

    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      input.removeEventListener("keydown", onKey);
      box.removeEventListener("mousedown", onBackdrop);
      closeModal("prompt");
      resolve(result);
    };
    const onOk = () => finish(input.value.trim() || null);
    const onCancel = () => finish(null);
    const onKey = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        onOk();
      } else if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    const onBackdrop = (e) => {
      if (e.target === box) onCancel();
    };
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    input.addEventListener("keydown", onKey);
    box.addEventListener("mousedown", onBackdrop);
  });
}

async function renameDraft(id) {
  const d = drafts.get(id);
  if (!d) return;
  const name = await promptText({
    title: "Rename draft",
    value: draftTitle(d),
    okLabel: "Rename",
  });
  if (name === null) return; // cancelled
  d.title = name;
  d.updated_at = Date.now();
  await invoke("save_draft", { draft: d }).catch((e) => console.error(e));
  renderAll();
}

async function copyText(text, msg) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;opacity:0";
    document.body.append(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } finally {
      ta.remove();
    }
  }
  showToast(msg);
}

async function revealDraft(path) {
  if (!path) return;
  try {
    await revealItemInDir(path);
  } catch (err) {
    console.error("reveal failed:", err);
    showToast("Couldn't reveal the file");
  }
}

function escapeHtml(s) {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
}

/** Standalone HTML document from a draft's markdown, for Export. */
function exportHtml(title, content) {
  const body = md.render(content || "");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  body { max-width: 720px; margin: 40px auto; padding: 0 20px;
    font: 16px/1.65 -apple-system, system-ui, sans-serif; color: #1d1d1f; }
  h1, h2, h3, h4 { line-height: 1.25; }
  pre { background: #f4f4f6; padding: 12px 14px; border-radius: 8px; overflow-x: auto; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em; }
  pre code { background: none; }
  blockquote { margin: 0 0 1em; padding-left: 1em; border-left: 3px solid #ddd; color: #666; }
  a { color: #0a84ff; }
  @media (prefers-color-scheme: dark) {
    body { background: #1a1a1a; color: #e8e8e8; }
    pre { background: #262628; }
    blockquote { border-color: #444; color: #aaa; }
  }
</style>
</head>
<body class="markdown-body">
${body}
</body>
</html>
`;
}

async function exportDraft(id) {
  const d = drafts.get(id);
  if (!d) return;
  const content = id === currentId ? editor.value : d.content;
  const stem =
    (d.file_path ? baseName(d.file_path).replace(/\.[^.]+$/, "") : draftTitle(d)) || "Untitled";
  const path = await saveDialog({
    defaultPath: `${stem}.md`,
    filters: [
      { name: "Markdown", extensions: ["md"] },
      { name: "Plain Text", extensions: ["txt"] },
      { name: "HTML", extensions: ["html"] },
    ],
  });
  if (!path) return;
  const contents = /\.html?$/i.test(path) ? exportHtml(draftTitle(d), content) : content;
  try {
    await invoke("write_text_file", { path, contents });
    showToast("Exported");
  } catch (err) {
    console.error("export failed:", err);
    showToast("Export failed");
  }
}

// Keyboard-shortcut hints shown in the context menu. These mirror the global
// accelerators wired in init(); the accelerators act on the *active* draft, while
// the menu acts on the right-clicked one — the hint is for discoverability.
const ACCEL = {
  pin: "⌃⌘P",
  export: "⇧⌘E",
  share: "⇧⌘L",
  delete: "⌘⌫",
};

/** Open the draft context menu at the event position. */
function openDraftMenu(e, id) {
  e.preventDefault();
  const d = drafts.get(id);
  if (!d) return;
  const hasFile = !!d.file_path;
  const items = [
    { label: d.pinned ? "Unpin" : "Pin", accel: ACCEL.pin, action: () => togglePin(id) },
    { separator: true },
    { label: "Rename…", action: () => renameDraft(id) },
    { label: "Copy Path", action: () => copyText(d.file_path, "Path copied"), disabled: !hasFile },
    { label: "Reveal in Finder", action: () => revealDraft(d.file_path), disabled: !hasFile },
    { separator: true },
    { label: "Export…", accel: ACCEL.export, action: () => exportDraft(id) },
  ];
  // Sharing entries — only when a worker is configured.
  if (cloudConfigured) {
    items.push({ separator: true });
    if (sharedById.has(id)) {
      items.push({
        label: "Copy Share Link",
        accel: ACCEL.share,
        action: () => copyText(sharedById.get(id).url, "Link copied"),
      });
      items.push({ label: "Stop Sharing", action: () => stopSharing(id) });
    } else {
      items.push({ label: "Share…", accel: ACCEL.share, action: () => shareDraft(id) });
    }
  }
  items.push(
    { separator: true },
    {
      label: "Delete",
      accel: ACCEL.delete,
      action: () => deleteDraft(id),
    },
  );
  showContextMenu(e.clientX, e.clientY, items);
}

// Create a public link for a draft (snapshotting the latest content) and copy it.
async function shareDraft(id) {
  try {
    if (id === currentId) await flush(); // persist the newest edit before snapshot
    const info = await invoke("create_share", { id });
    sharedById.set(id, info);
    applyDraftMarks();
    copyText(info.url, "Public link copied — anyone with it can read this note");
  } catch (err) {
    console.error("create_share failed:", err);
    showToast("Couldn't create the share link");
  }
}

// Toggle a draft's sidebar pin. Pinned state is a synced Draft field, so bumping
// updated_at makes the change eligible for the next sync push (last-write-wins) —
// it also floats the row to the top of its group, matching the just-acted-on feel.
async function togglePin(id) {
  const d = drafts.get(id);
  if (!d) return;
  d.pinned = !d.pinned;
  d.updated_at = Date.now();
  try {
    await invoke("save_draft", { draft: d });
    scheduleSync();
  } catch (err) {
    console.error("pin toggle failed:", err);
  }
  renderList(); // re-order + repaint the pin class/marker
  showToast(d.pinned ? "Pinned to top" : "Unpinned");
}

// Revoke a draft's public link (hard delete — the link 404s immediately).
async function stopSharing(id) {
  try {
    await invoke("revoke_share", { id });
    sharedById.delete(id);
    applyDraftMarks();
    showToast("Sharing stopped — the link no longer works");
  } catch (err) {
    console.error("revoke_share failed:", err);
    showToast("Couldn't stop sharing");
  }
}

// Silently revoke a share as part of deleting its draft (no toast — the delete
// already told the story). No-op unless the draft is actually shared. The worker
// also cascades a revoke when the delete tombstone syncs, so this is the fast path.
async function revokeShareOnDelete(id) {
  if (!sharedById.has(id)) return;
  try {
    await invoke("revoke_share", { id });
    sharedById.delete(id);
  } catch (err) {
    console.error("revoke on delete failed:", err);
  }
}

// --- quick switcher (⌘P) -------------------------------------------------

let switcherResults = [];
let switcherSel = 0;

function switcherMatches(query) {
  const q = query.trim().toLowerCase();
  return orderedDrafts().filter(
    (d) =>
      isSaved(d) &&
      (!q || draftTitle(d).toLowerCase().includes(q) || d.content.toLowerCase().includes(q)),
  );
}

function renderSwitcher(query) {
  const list = document.getElementById("switcher-list");
  switcherResults = switcherMatches(query);
  switcherSel = 0;
  list.replaceChildren();

  if (switcherResults.length === 0) {
    const li = document.createElement("li");
    li.className = "switcher-empty";
    li.textContent = "No matching drafts";
    list.append(li);
    return;
  }
  switcherResults.forEach((d, i) => {
    const li = document.createElement("li");
    li.className = "switcher-item" + (i === 0 ? " sel" : "");
    li.dataset.id = d.id;
    const t = document.createElement("div");
    t.className = "s-title";
    t.textContent = draftTitle(d);
    const s = document.createElement("div");
    s.className = "s-sub";
    s.textContent = `${draftSubText(d)} · ${relTime(d.updated_at)}`;
    li.append(t, s);
    li.addEventListener("click", () => chooseSwitcher(i));
    li.addEventListener("mousemove", () => setSwitcherSel(i));
    list.append(li);
  });
}

function setSwitcherSel(i) {
  const items = document.querySelectorAll("#switcher-list .switcher-item");
  if (!items.length) return;
  switcherSel = (i + items.length) % items.length;
  items.forEach((el, k) => el.classList.toggle("sel", k === switcherSel));
  items[switcherSel].scrollIntoView({ block: "nearest" });
}

function chooseSwitcher(i) {
  const d = switcherResults[i];
  closeModal("switcher");
  if (d) openInTab(d.id);
}

function openSwitcher() {
  if (switcherMatches("").length === 0) {
    showToast("No drafts to open yet");
    return;
  }
  const input = document.getElementById("switcher-input");
  input.value = "";
  openModal("switcher");
  renderSwitcher("");
  input.focus();
}

function initSwitcher() {
  const input = document.getElementById("switcher-input");
  input.addEventListener("input", () => renderSwitcher(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSwitcherSel(switcherSel + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSwitcherSel(switcherSel - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      chooseSwitcher(switcherSel);
    } else if (e.key === "Escape") {
      closeModal("switcher");
    }
  });
  bindBackdrop("switcher");
}

// --- find & replace ------------------------------------------------------

function computeMatches() {
  find.matches = findMatches(editor.value, findInput.value, find.caseSensitive);
}

function updateFindCount() {
  const n = find.matches.length;
  if (n === 0) {
    findCount.textContent = findInput.value ? "No results" : "";
  } else {
    findCount.textContent = `${find.idx + 1} of ${n}`;
  }
}

function scrollToOffset(offset) {
  const line = editor.value.slice(0, offset).split("\n").length - 1;
  const lh = parseFloat(getComputedStyle(editor).lineHeight) || 22;
  const y = line * lh;
  if (y < editor.scrollTop || y > editor.scrollTop + editor.clientHeight - lh * 2) {
    editor.scrollTop = Math.max(0, y - editor.clientHeight / 2);
  }
}

/** Reveal the current match without pulling focus out of the find field. */
function revealCurrent() {
  if (find.idx < 0 || !find.matches[find.idx]) {
    updateFindCount();
    return;
  }
  const [s, e] = find.matches[find.idx];
  editor.setSelectionRange(s, e);
  scrollToOffset(s);
  updateFindCount();
}

function goNext() {
  if (!find.matches.length) return;
  find.idx = (find.idx + 1) % find.matches.length;
  revealCurrent();
}

function goPrev() {
  if (!find.matches.length) return;
  find.idx = (find.idx - 1 + find.matches.length) % find.matches.length;
  revealCurrent();
}

function onFindQuery() {
  computeMatches();
  find.idx = find.matches.length ? 0 : -1;
  revealCurrent();
}

function openFind(withReplace) {
  findbar.hidden = false;
  find.open = true;
  if (withReplace) {
    replaceRow.hidden = false;
  }
  const sel = editor.value.slice(editor.selectionStart, editor.selectionEnd);
  if (sel && !sel.includes("\n")) findInput.value = sel;
  onFindQuery();
  findInput.focus();
  findInput.select();
}

function closeFind() {
  findbar.hidden = true;
  find.open = false;
  editor.focus();
}

function applyEditorValue(newVal, caret) {
  editor.value = newVal;
  if (caret != null) editor.setSelectionRange(caret, caret);
  // Commit synchronously so replace can read fresh matches immediately.
  const d = drafts.get(currentId);
  if (d) {
    d.content = newVal;
    d.updated_at = Date.now();
  }
  if (find.open) computeMatches();
  scheduleSave();
  if (!uiRaf) uiRaf = requestAnimationFrame(flushUi);
}

function replaceOne() {
  if (!find.matches.length) return;
  if (find.idx < 0) find.idx = 0;
  const [s, e] = find.matches[find.idx];
  const rep = replaceInput.value;
  const caret = s + rep.length;
  applyEditorValue(editor.value.slice(0, s) + rep + editor.value.slice(e), caret);
  // onInput has recomputed matches; jump to the next one after the replacement.
  const i = find.matches.findIndex(([ms]) => ms >= caret);
  find.idx = find.matches.length ? (i === -1 ? 0 : i) : -1;
  revealCurrent();
}

function replaceAll() {
  if (!find.matches.length) return;
  const rep = replaceInput.value;
  let text = editor.value;
  for (let k = find.matches.length - 1; k >= 0; k--) {
    const [s, e] = find.matches[k];
    text = text.slice(0, s) + rep + text.slice(e);
  }
  applyEditorValue(text, null);
  find.idx = find.matches.length ? 0 : -1;
  revealCurrent();
}

function toggleCase() {
  find.caseSensitive = !find.caseSensitive;
  findCaseBtn.classList.toggle("active", find.caseSensitive);
  onFindQuery();
}

function initFind() {
  findbar = document.getElementById("findbar");
  findInput = document.getElementById("find-input");
  replaceInput = document.getElementById("replace-input");
  replaceRow = document.getElementById("find-replace-row");
  findCount = document.getElementById("find-count");
  findCaseBtn = document.getElementById("find-case");

  findInput.addEventListener("input", onFindQuery);
  findInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.shiftKey ? goPrev() : goNext();
    } else if (e.key === "Escape") {
      closeFind();
    }
  });
  replaceInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      replaceOne();
    } else if (e.key === "Escape") {
      closeFind();
    }
  });

  document.getElementById("find-next").addEventListener("click", goNext);
  document.getElementById("find-prev").addEventListener("click", goPrev);
  document.getElementById("find-close").addEventListener("click", closeFind);
  document.getElementById("find-case").addEventListener("click", toggleCase);
  document.getElementById("find-replace-toggle").addEventListener("click", () => {
    replaceRow.hidden = !replaceRow.hidden;
    if (!replaceRow.hidden) replaceInput.focus();
  });
  document.getElementById("replace-one").addEventListener("click", replaceOne);
  document.getElementById("replace-all").addEventListener("click", replaceAll);
}

// --- modals --------------------------------------------------------------

function openModal(id) {
  const el = document.getElementById(id);
  el.classList.remove("closing");
  el.hidden = false;
}

function closeModal(id) {
  const el = document.getElementById(id);
  el.classList.add("closing");
  setTimeout(() => {
    el.hidden = true;
    el.classList.remove("closing");
  }, 160);
}

function bindBackdrop(id) {
  const el = document.getElementById(id);
  el.addEventListener("click", (e) => {
    if (e.target === el) closeModal(id);
  });
}

/** True while any overlay (settings / quick-open / prompt) is showing. */
function anyModalOpen() {
  return ["settings", "switcher", "prompt"].some((id) => !document.getElementById(id).hidden);
}

/** True when focus is in a text field, where a keystroke is editing, not a command. */
function isEditableFocused() {
  const el = document.activeElement;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
}

// --- init ----------------------------------------------------------------

async function init() {
  editor = document.getElementById("editor");
  listEl = document.getElementById("draft-list");
  tabsEl = document.getElementById("tabs");
  searchEl = document.getElementById("search");
  previewEl = document.getElementById("preview");

  // Sidebar always starts closed (state is not remembered between launches).
  document.body.classList.add("sidebar-hidden");

  applyAllSettings();
  initSettings();
  initFind();
  initSwitcher();
  bindBackdrop("settings");

  const list = await invoke("init_store");
  for (const d of list) drafts.set(d.id, d);

  // Every launch starts on a fresh, clean page. Past notes live in the sidebar.
  const blank = createBlankDraft();
  openTabs = [blank.id];
  currentId = blank.id;
  editor.value = "";

  renderAll();

  editor.addEventListener("input", onInput);
  for (const ev of ["keyup", "click", "select"]) {
    editor.addEventListener(ev, queueStatus);
  }
  document.getElementById("new-draft").addEventListener("click", newTab);
  document.getElementById("new-tab").addEventListener("click", newTab);
  document.getElementById("preview-toggle").addEventListener("click", togglePreview);
  searchEl.addEventListener("input", () => {
    searchQuery = searchEl.value.trim().toLowerCase();
    renderList();
  });

  // Tab cycling lives here, not on a native menu accelerator: Tab-based
  // accelerators (Control+Tab) don't fire reliably on macOS.
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === "Tab") {
      e.preventDefault();
      cycleTab(e.shiftKey ? -1 : 1);
    }
  });

  // Draft-action accelerators (mirrored as hints in the context menu). All act on
  // the active draft. Keyed off e.code so they're layout- and case-independent, and
  // inert while a modal is open so they don't act on a draft hidden behind it.
  document.addEventListener("keydown", (e) => {
    if (!e.metaKey || e.altKey || anyModalOpen()) return;
    const id = currentId;
    const d = drafts.get(id);
    const saved = !!d && isSaved(d);
    if (e.shiftKey && !e.ctrlKey && e.code === "KeyL") {
      // ⇧⌘L — Share, or copy the link if already shared.
      e.preventDefault();
      if (cloudConfigured && saved) {
        if (sharedById.has(id)) copyText(sharedById.get(id).url, "Link copied");
        else shareDraft(id);
      }
    } else if (e.shiftKey && !e.ctrlKey && e.code === "KeyE") {
      e.preventDefault(); // ⇧⌘E — Export
      if (saved) exportDraft(id);
    } else if (e.ctrlKey && !e.shiftKey && e.code === "KeyP") {
      e.preventDefault(); // ⌃⌘P — Pin / Unpin
      if (saved) togglePin(id);
    } else if (!e.shiftKey && !e.ctrlKey && (e.code === "Backspace" || e.code === "Delete")) {
      // ⌘⌫ — Delete. Never hijack a text field: there ⌘⌫ means delete-to-line-start.
      if (isEditableFocused()) return;
      if (saved) {
        e.preventDefault();
        deleteDraft(id);
      }
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!document.getElementById("switcher").hidden) closeModal("switcher");
      else if (!document.getElementById("settings").hidden) closeModal("settings");
      else if (find.open) closeFind();
      else if (document.activeElement === searchEl) {
        searchEl.value = "";
        searchQuery = "";
        renderList();
        editor.focus();
      }
    }
  });

  await listen("menu", (event) => {
    switch (event.payload) {
      case "new":
        newTab();
        break;
      case "open":
        openFile();
        break;
      case "save":
        save();
        break;
      case "save_as":
        saveAs();
        break;
      case "close_tab":
        closeTab(currentId);
        break;
      case "reopen_tab":
        reopenClosedTab();
        break;
      case "switcher":
        openSwitcher();
        break;
      case "next_tab":
        cycleTab(1);
        break;
      case "prev_tab":
        cycleTab(-1);
        break;
      case "find":
        openFind(false);
        break;
      case "find_next":
        find.open ? goNext() : openFind(false);
        break;
      case "find_prev":
        find.open ? goPrev() : openFind(false);
        break;
      case "toggle_sidebar":
        toggleSidebar();
        break;
      case "toggle_preview":
        togglePreview();
        break;
      case "settings":
        openSettings("general");
        break;
      case "about":
        openSettings("about");
        break;
    }
  });

  // Cloud sync status -> status-bar indicator + sidebar-button spinner.
  // No-op visuals unless a sync actually runs (only fires when configured).
  await listen("sync:status", (event) => {
    const p = event.payload || {};
    const sb = document.getElementById("sidebar-sync");
    if (sb) sb.classList.toggle("syncing", p.state === "syncing");
    if (p.state === "syncing") {
      setSyncBar("Syncing…", "syncing");
    } else if (p.state === "error") {
      setSyncBar("Offline", "err", p.message || "");
      // Back off and retry: 15s, 30s, 60s, … capped at 5 minutes.
      syncFailures += 1;
      clearTimeout(syncRetryTimer);
      const delay = Math.min(5 * 60 * 1000, SYNC_DEBOUNCE_MS * 2 ** (syncFailures - 1));
      syncRetryTimer = setTimeout(() => invoke("sync_now").catch(() => {}), delay);
    } else {
      const when = p.at ? new Date(p.at).toLocaleTimeString() : "";
      setSyncBar("Synced", "", when ? `Last synced ${when}` : "");
      syncFailures = 0;
      clearTimeout(syncRetryTimer);
      refreshSyncedMarks(); // a push may have changed synced ids without a local change
    }
  });
  await listen("sync:changed", () => refreshFromSync());
  document
    .getElementById("sidebar-sync")
    .addEventListener("click", () => invoke("sync_now").catch(() => {}));
  await refreshSyncChrome();
  refreshSyncedMarks();
  refreshShares();
  // Launch-time sync a couple seconds after boot (no-op when unconfigured).
  setTimeout(() => invoke("sync_now").catch(() => {}), 2500);

  window.addEventListener("beforeunload", () => {
    const d = drafts.get(currentId);
    if (d && !isEmpty(d)) {
      d.content = editor.value;
      invoke("save_draft", { draft: d });
    }
    if (cloudConfigured) invoke("sync_now").catch(() => {}); // best-effort final sync
  });

  focusEnd();
  requestAnimationFrame(() => document.body.classList.add("ready"));

  // Quietly check for updates shortly after launch (no-op until configured).
  if (autoUpdateOn()) setTimeout(() => checkForUpdates({ silent: true }), 3000);
}

window.addEventListener("DOMContentLoaded", init);
