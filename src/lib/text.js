// Pure, dependency-free text/draft helpers. Unit-tested in text.test.js.
// A "draft" here is `{ content: string, file_path: string | null, updated_at, ... }`.

/** Basename of a file path (handles / and \), or null. */
export function baseName(p) {
  return p ? p.split(/[/\\]/).pop() : null;
}

/** First non-empty line — scans without allocating a full split of a huge string. */
export function firstLine(content) {
  let start = 0;
  while (start < content.length) {
    let nl = content.indexOf("\n", start);
    if (nl === -1) nl = content.length;
    const t = content.slice(start, nl).trim();
    if (t) return t;
    start = nl + 1;
  }
  return "";
}

/** Display title: a user-set name (via Rename), else file name, else first line
 * (≤60 chars), else "New Draft". */
export function draftTitle(d) {
  return (
    (d.title && d.title.trim()) ||
    baseName(d.file_path) ||
    firstLine(d.content).slice(0, 60) ||
    "New Draft"
  );
}

/** One-line preview (text after the first line), bounded for long docs. */
export function draftPreview(d) {
  const lines = d.content
    .slice(0, 600)
    .split("\n")
    .map((l) => l.trim());
  return lines.filter(Boolean).slice(1).join(" ").slice(0, 80);
}

/** A draft is "empty" (never persisted) when it has no text and no file. */
export function isEmpty(d) {
  return d.content.trim() === "" && !d.file_path;
}

/** Compact relative time: "now", "5m", "3h", "2d", "1w". `now` is injectable for tests. */
export function relTime(ms, now = Date.now()) {
  if (!ms) return "";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const days = Math.round(h / 24);
  if (days < 7) return `${days}d`;
  return `${Math.round(days / 7)}w`;
}

/** Columns a hard tab stands for when deciding how much a line un-indents by. */
const TAB_WIDTH = 4;

/** Offset of the first character on the line containing `pos`. */
function lineStartAt(text, pos) {
  return text.lastIndexOf("\n", pos - 1) + 1;
}

/** How many leading characters one outdent step removes from `line`. */
function outdentCount(line, unit) {
  if (line.startsWith("\t")) return 1;
  const width = unit === "\t" ? TAB_WIDTH : unit.length;
  let n = 0;
  while (n < width && line[n] === " ") n += 1;
  return n;
}

/** Tab / Shift-Tab in the editor, as a region replacement.
 *
 * Returned as `{ from, to, text }` (plus the resulting selection) rather than a
 * whole new document so the caller can apply it with `insertText` and leave the
 * native undo stack intact.
 *
 * Follows the editor convention: Tab on a caret or a within-one-line selection
 * inserts `unit`; Tab on a multi-line selection, and Shift-Tab always, work on
 * whole lines. Blank lines inside a block are left alone.
 *
 * @param {string} text Full editor contents.
 * @param {number} start Selection start offset.
 * @param {number} end Selection end offset.
 * @param {string} unit One indent step — `"\t"`, `"  "`, or `"    "`.
 * @param {boolean} outdent Remove one step instead of adding one.
 * @returns {{from: number, to: number, text: string, selStart: number, selEnd: number} | null}
 *   `null` when the keypress would change nothing.
 */
export function indentEdit(text, start, end, unit, outdent = false) {
  if (!outdent && !text.slice(start, end).includes("\n")) {
    const caret = start + unit.length;
    return { from: start, to: end, text: unit, selStart: caret, selEnd: caret };
  }

  // Line block covering the selection. A selection ending exactly at a line
  // start doesn't drag that next line in.
  const from = lineStartAt(text, start);
  const last = end > start && text[end - 1] === "\n" ? end - 1 : end;
  const nl = text.indexOf("\n", last);
  const to = nl === -1 ? text.length : nl;

  const lines = text.slice(from, to).split("\n");
  const next = [];
  let firstDelta = 0;
  let totalDelta = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    let delta = 0;
    if (outdent) {
      delta = -outdentCount(line, unit);
      next.push(line.slice(-delta));
    } else if (line === "" && lines.length > 1) {
      next.push(line);
    } else {
      delta = unit.length;
      next.push(unit + line);
    }
    if (i === 0) firstDelta = delta;
    totalDelta += delta;
  }

  const replacement = next.join("\n");
  if (replacement === text.slice(from, to)) return null;
  // A selection anchored at a line start stays there, so the new indent lands
  // inside the selection rather than in front of it.
  const selStart = start === from ? from : Math.max(from, start + firstDelta);
  const selEnd = start === end ? selStart : Math.max(selStart, end + totalDelta);
  return { from, to, text: replacement, selStart, selEnd };
}

/** All `[start, end)` offsets of `query` in `text`. Plain (non-overlapping) substring search. */
export function findMatches(text, query, caseSensitive = false) {
  const matches = [];
  if (!query) return matches;
  const hay = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const step = Math.max(1, needle.length);
  let i = hay.indexOf(needle);
  while (i !== -1) {
    matches.push([i, i + needle.length]);
    i = hay.indexOf(needle, i + step);
  }
  return matches;
}
