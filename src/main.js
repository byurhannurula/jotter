import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ask,
  open as openDialog,
  save as saveDialog,
} from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import MarkdownIt from "markdown-it";
import {
  draftTitle,
  draftPreview,
  isEmpty,
  relTime,
  findMatches,
} from "./lib/text.js";
import { APP } from "./lib/meta.js";

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
  return [...drafts.values()].sort((a, b) => b.updated_at - a.updated_at);
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
  };
  drafts.set(d.id, d);
  return d;
}

// --- sidebar rendering ---------------------------------------------------

function makeItem(d) {
  const li = document.createElement("li");
  li.className = "draft-item" + (d.id === currentId ? " active" : "");
  li.dataset.id = d.id;
  li.title = draftTooltip(d);

  const title = document.createElement("div");
  title.className = "draft-title";
  title.textContent = draftTitle(d);

  const sub = document.createElement("div");
  sub.className = "draft-sub";
  const preview = document.createElement("span");
  preview.className = "preview";
  preview.textContent = draftPreview(d) || "No additional text";
  const time = document.createElement("span");
  time.className = "time";
  time.textContent = relTime(d.updated_at);
  sub.append(preview, time);

  const del = document.createElement("button");
  del.className = "draft-del";
  del.textContent = "×";
  del.title = "Delete draft";
  del.addEventListener("click", (e) => {
    e.stopPropagation();
    deleteDraft(d.id);
  });

  li.append(title, sub, del);
  li.addEventListener("click", () => openInTab(d.id));
  return li;
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
  const d = drafts.get(currentId);
  const li = itemEls.get(currentId);
  if (!d || !li) {
    renderList();
    return;
  }
  li.querySelector(".draft-title").textContent = draftTitle(d);
  li.querySelector(".preview").textContent =
    draftPreview(d) || "No additional text";
  li.querySelector(".time").textContent = relTime(d.updated_at);
  if (listEl.firstElementChild !== li) listEl.prepend(li);
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
    close.textContent = "×";
    close.title = "Close tab (⌘W)";
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(id);
    });

    tab.append(title, close);
    tab.addEventListener("click", () => activate(id));
    tabsEl.append(tab);
  }
}

/** Re-render tabs + sidebar + window title together (used after any nav change). */
function renderAll() {
  renderTabs();
  renderList();
  updateWindowTitle();
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
  currentId = id;
  editor.value = d.content;
  renderAll();
  focusEnd();
}

async function openInTab(id) {
  if (!drafts.has(id)) return;
  if (!openTabs.includes(id)) openTabs.push(id);
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
  if (id === currentId) await flush();

  openTabs.splice(idx, 1);
  previewTabs.delete(id);
  pruneIfEmpty(id);

  if (openTabs.length === 0) {
    const d = createBlankDraft();
    openTabs.push(d.id);
    currentId = d.id;
    editor.value = "";
  } else if (id === currentId) {
    const next = openTabs[Math.min(idx, openTabs.length - 1)];
    currentId = next;
    editor.value = drafts.get(next).content;
  }
  renderAll();
  focusEnd();
}

function cycleTab(dir) {
  if (openTabs.length < 2) return;
  const i = openTabs.indexOf(currentId);
  const n = (i + dir + openTabs.length) % openTabs.length;
  activate(openTabs[n]);
}

async function deleteDraft(id) {
  const d = drafts.get(id);
  if (!d) return;
  const confirmed = await ask(
    `Delete "${draftTitle(d)}"? This can't be undone.`,
    { title: "Delete draft", kind: "warning" }
  );
  if (!confirmed) return;

  await invoke("delete_draft", { id }).catch((e) => console.error(e));
  drafts.delete(id);
  previewTabs.delete(id);
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

  const tabTitle = tabsEl.querySelector(
    `.tab[data-id="${CSS.escape(currentId)}"] .tab-title`
  );
  if (tabTitle) tabTitle.textContent = draftTitle(d);

  updateWindowTitle();
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
  document.documentElement.style.setProperty(
    "--editor-family",
    FONTS[v] || FONTS.system
  );
}
function applySize(v) {
  document.documentElement.style.setProperty("--editor-size", `${v}px`);
}
function applyWrap(v) {
  if (editor) editor.wrap = v === "off" ? "off" : "soft";
}

// Each setting renders into a section as a segmented control.
const SETTINGS = {
  theme: {
    section: "general", label: "Appearance", def: "system", apply: applyTheme,
    options: [["system", "System"], ["light", "Light"], ["dark", "Dark"]],
  },
  font: {
    section: "editor", label: "Font", def: "system", apply: applyFont,
    options: [["system", "System"], ["serif", "Serif"], ["mono", "Mono"], ["rounded", "Rounded"]],
  },
  size: {
    section: "editor", label: "Text size", def: "15.5", apply: applySize,
    options: [["14", "Small"], ["15.5", "Medium"], ["17", "Large"]],
  },
  wrap: {
    section: "editor", label: "Word wrap", def: "on", apply: applyWrap,
    options: [["on", "On"], ["off", "Off"]],
  },
};

const GITHUB = APP.links.find((l) => /github\.com/.test(l.url))?.url || "";

const SHORTCUTS = [
  ["File", [["⌘N / ⌘T", "New tab"], ["⌘O", "Open file"], ["⌘S / ⇧⌘S", "Save / Save As"], ["⌘W", "Close tab"]]],
  ["Edit", [["⌘Z / ⇧⌘Z", "Undo / Redo"], ["⌘F", "Find"], ["⌘G / ⇧⌘G", "Find next / previous"]]],
  ["View", [["⌘B", "Toggle sidebar"], ["⇧⌘P", "Toggle markdown preview"], ["⌘,", "Settings"]]],
  ["Tabs", [["⌃Tab / ⌃⇧Tab", "Next / previous tab"]]],
];

let eggClicks = 0;

function getSetting(name) {
  return localStorage.getItem(`set-${name}`) ?? SETTINGS[name].def;
}
function setSetting(name, val) {
  localStorage.setItem(`set-${name}`, val);
  SETTINGS[name].apply(val);
  markSeg(name, val);
}
function markSeg(name, val) {
  const group = document.getElementById(`set-${name}`);
  if (!group) return;
  for (const btn of group.querySelectorAll("button")) {
    btn.classList.toggle("active", btn.dataset.val === String(val));
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
  row.append(label, seg);
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
  toggle.className = "switch";
  toggle.disabled = true;
  toggle.title = "Coming in a future version";
  autoRow.append(toggle);
  const checkRow = groupRow();
  const check = document.createElement("button");
  check.className = "group-link";
  check.textContent = "Check for updates…";
  check.addEventListener("click", () =>
    openUrl(GITHUB ? `${GITHUB}/releases/latest` : "").catch(() => {})
  );
  checkRow.append(check);
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
        { timeout: 7000 }
      );
    }
  });
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
    markSeg(name, getSetting(name));
  }
  renderShortcutsSection();
  renderAboutSection();
  showSection("general");
  for (const r of document.querySelectorAll(".rail-item")) {
    r.addEventListener("click", () => showSection(r.dataset.section));
  }
  document
    .getElementById("settings-close")
    .addEventListener("click", () => closeModal("settings"));
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
  document.getElementById("new-draft").addEventListener("click", newTab);
  document.getElementById("new-tab").addEventListener("click", newTab);
  document.getElementById("preview-toggle").addEventListener("click", togglePreview);
  searchEl.addEventListener("input", () => {
    searchQuery = searchEl.value.trim().toLowerCase();
    renderList();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!document.getElementById("settings").hidden) closeModal("settings");
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
      case "new": newTab(); break;
      case "open": openFile(); break;
      case "save": save(); break;
      case "save_as": saveAs(); break;
      case "close_tab": closeTab(currentId); break;
      case "next_tab": cycleTab(1); break;
      case "prev_tab": cycleTab(-1); break;
      case "find": openFind(false); break;
      case "find_next": find.open ? goNext() : openFind(false); break;
      case "find_prev": find.open ? goPrev() : openFind(false); break;
      case "toggle_sidebar": toggleSidebar(); break;
      case "toggle_preview": togglePreview(); break;
      case "settings": openSettings("general"); break;
      case "about": openSettings("about"); break;
    }
  });

  window.addEventListener("beforeunload", () => {
    const d = drafts.get(currentId);
    if (d && !isEmpty(d)) {
      d.content = editor.value;
      invoke("save_draft", { draft: d });
    }
  });

  focusEnd();
  requestAnimationFrame(() => document.body.classList.add("ready"));
}

window.addEventListener("DOMContentLoaded", init);
