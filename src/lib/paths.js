// How a path is shown to a person: folder only, home as `~`, long ones cut in
// the middle. Pure functions; the caller passes the home folder in.

/** The folder part of a path, or the path itself when it has no separator. */
export function dirName(p) {
  return p.replace(/[/\\][^/\\]*$/, "") || p;
}

/** `/Users/me/Notes` -> `~/Notes` when `home` is `/Users/me`, the way a Mac
 *  shows a path to a person. Left alone on Windows, where `~` is not the
 *  convention, and when `home` is unknown. */
export function tildePath(p, home) {
  if (!home || p.includes("\\") || !p.startsWith(home)) return p;
  const rest = p.slice(home.length);
  if (rest && !rest.startsWith("/")) return p; // `/Users/meow` is not under `/Users/me`
  const tail = rest.replace(/^\//, "");
  return tail ? `~/${tail}` : "~";
}

/** Abbreviate a long path from the middle, keeping the root and the last few
 *  folders, the two ends that say where you are. Done here rather than with
 *  CSS: left-truncating via `direction: rtl` reorders a leading `~` or `/` to
 *  the far end, which reads as a different path entirely. */
export function shortPath(p, home, max = 44) {
  const full = tildePath(p, home);
  if (full.length <= max) return full;

  const sep = full.includes("\\") ? "\\" : "/";
  const parts = full.split(/[/\\]/);
  // A posix absolute path splits to a leading "", which is what puts the root
  // separator back when the pieces are rejoined; on Windows the head is "C:".
  // A UNC path (\\server\share) splits to two leading empties and needs both.
  const head = parts[0] === "" && full.startsWith(sep + sep) ? sep : parts[0];
  let tail = [];
  for (let i = parts.length - 1; i > 0; i -= 1) {
    const next = [parts[i], ...tail];
    if (tail.length && `${head}${sep}…${sep}${next.join(sep)}`.length > max) break;
    tail = next;
  }
  // If nothing was actually dropped, the ellipsis would be a lie (and longer).
  if (tail.length >= parts.length - 1) return full;
  return `${head}${sep}…${sep}${tail.join(sep)}`;
}
