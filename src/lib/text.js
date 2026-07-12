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

/** Display title: file name, else first line (≤60 chars), else "New Draft". */
export function draftTitle(d) {
  return baseName(d.file_path) || firstLine(d.content).slice(0, 60) || "New Draft";
}

/** One-line preview (text after the first line), bounded for long docs. */
export function draftPreview(d) {
  const lines = d.content.slice(0, 600).split("\n").map((l) => l.trim());
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
