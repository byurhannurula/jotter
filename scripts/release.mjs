// Cut a release: bump the version everywhere, gate on tests, tag, and push.
//
//   pnpm release <patch|minor|major>   normal release
//   pnpm release <patch|minor|major> --dry-run   print what would change, touch nothing
//
// Pushing the tag triggers .github/workflows/release.yml, which builds the
// installers and drafts a GitHub Release. Publishing that draft is manual.
//
// The version lives in four files; this keeps them in lockstep:
//   package.json · src-tauri/tauri.conf.json · src-tauri/Cargo.toml · src/lib/meta.js

import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const dry = args.includes("--dry-run");
const bump = args.find((a) => !a.startsWith("-"));

if (!["patch", "minor", "major"].includes(bump)) {
  console.error("usage: pnpm release <patch|minor|major> [--dry-run]");
  process.exit(1);
}

const run = (cmd) => execSync(cmd, { cwd: root, stdio: "inherit" });
const out = (cmd) => execSync(cmd, { cwd: root, encoding: "utf8" }).trim();
const path = (p) => resolve(root, p);

// 0. Preflight — release only from a clean, up-to-date main.
// In --dry-run these are warnings so you can preview from a dirty tree.
const guard = (bad, msg) => {
  if (!bad) return;
  if (dry) console.warn(`  ! ${msg} (ignored for --dry-run)`);
  else throw new Error(msg);
};
guard(out("git rev-parse --abbrev-ref HEAD") !== "main", "release from `main` only");
// Only tracked changes block a release; stray untracked files (local notes, plan
// docs) are irrelevant to what CI checks out and builds.
guard(
  !!out("git status --porcelain --untracked-files=no"),
  "tracked changes not committed — commit or stash first",
);
if (!dry) run("git pull --ff-only");

// 1. Compute the next version from package.json.
const pkg = JSON.parse(readFileSync(path("package.json"), "utf8"));
const [maj, min, pat] = pkg.version.split(".").map(Number);
const next =
  bump === "major"
    ? `${maj + 1}.0.0`
    : bump === "minor"
      ? `${maj}.${min + 1}.0`
      : `${maj}.${min}.${pat + 1}`;
console.log(`\n  ${pkg.version} -> ${next}  (${bump})\n`);

// 2. Write it into every file (targeted replacements → minimal diffs).
const edits = [
  ["package.json", /("version":\s*")[^"]+/],
  ["src-tauri/tauri.conf.json", /("version":\s*")[^"]+/],
  ["src-tauri/Cargo.toml", /(^version\s*=\s*")[^"]+/m],
  ["src/lib/meta.js", /(version:\s*")[^"]+/],
];
for (const [file, re] of edits) {
  const before = readFileSync(path(file), "utf8");
  const after = before.replace(re, `$1${next}`);
  if (after === before) throw new Error(`version pattern not found in ${file}`);
  console.log(`  ${dry ? "would update" : "updated"} ${file}`);
  if (!dry) writeFileSync(path(file), after);
}

if (dry) {
  console.log("\n  --dry-run: no files written, no tag, no push.\n");
  process.exit(0);
}

// 3. Gate on the test suites. `cargo test` also heals Cargo.lock's version entry.
run("pnpm test --run");
run("cargo test --manifest-path src-tauri/Cargo.toml --quiet");

// 4. Commit, tag, push. The tag push is what CI watches for.
run(`git commit -aqm "Release v${next}"`);
run(`git tag -a v${next} -m "v${next}"`); // annotated so --follow-tags pushes it
run("git push origin main --follow-tags");

console.log(`\n  Pushed v${next}. CI will build the installers and draft the release.`);
console.log("  Review the draft on GitHub and click Publish to ship it.\n");
