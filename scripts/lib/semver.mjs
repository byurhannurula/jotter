// The version arithmetic and the list of files that carry the version, kept
// apart from release.mjs so both can be tested without touching git.

/** Every file that holds the app version, with the pattern that finds it. */
export const VERSION_FILES = [
  ["package.json", /("version":\s*")[^"]+/],
  ["src-tauri/tauri.conf.json", /("version":\s*")[^"]+/],
  ["src-tauri/Cargo.toml", /(^version\s*=\s*")[^"]+/m],
  ["src/lib/meta.js", /(version:\s*")[^"]+/],
];

/** `bumpVersion("0.4.0", "minor")` -> `"0.5.0"`. */
export function bumpVersion(version, kind) {
  const parts = version.split(".").map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new Error(`not a x.y.z version: ${version}`);
  }
  const [maj, min, pat] = parts;
  if (kind === "major") return `${maj + 1}.0.0`;
  if (kind === "minor") return `${maj}.${min + 1}.0`;
  if (kind === "patch") return `${maj}.${min}.${pat + 1}`;
  throw new Error(`unknown bump: ${kind}`);
}

/** Replace the version in one file's text; throws when the pattern is absent. */
export function setVersion(text, pattern, next, file = "file") {
  const after = text.replace(pattern, `$1${next}`);
  if (after === text) throw new Error(`version pattern not found in ${file}`);
  return after;
}
