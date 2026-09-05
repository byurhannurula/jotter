// Runs the suite one launch at a time. The Tauri service starts the app once
// per WebdriverIO run, so every `specs/launch-*` folder is one app process,
// and all of them share one throwaway data folder. That is how "quit and
// relaunch" is expressed: the next folder is the next launch.
//
// A folder may carry a `launch.json`:
//   { "files": { "note.txt": "text" }, "args": ["$DATA/note.txt"] }
// `files` are written into the data folder before the launch; `$DATA` in an
// arg is that folder. `"quits": true` says the folder's spec ends the app on
// purpose, so its non-zero status is not a failure.
//
//   pnpm e2e              every launch, in order
//   pnpm e2e launch-2     one folder (its earlier launches are assumed done)

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = import.meta.dirname;
const specsDir = join(here, "specs");
const win = process.platform === "win32";
const wdio = join(here, "..", "node_modules", ".bin", win ? "wdio.cmd" : "wdio");

const dataDir = process.env.JOTTER_DATA_DIR ?? mkdtempSync(join(tmpdir(), "jotter-e2e-"));
const only = process.argv[2];
const groups = readdirSync(specsDir)
  .filter((n) => n.startsWith("launch-") && (!only || n === only))
  .sort();

if (!groups.length) {
  console.error(`no launch folder ${only ?? ""} under ${specsDir}`);
  process.exit(2);
}

console.log(`data folder: ${dataDir}`);
let failed = 0;
for (const group of groups) {
  const dir = join(specsDir, group);
  const metaFile = join(dir, "launch.json");
  const meta = existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, "utf8")) : {};
  for (const [name, text] of Object.entries(meta.files ?? {})) {
    writeFileSync(join(dataDir, name), text);
  }
  const args = (meta.args ?? []).map((a) => a.replaceAll("$DATA", dataDir));
  console.log(`\n== ${group}${args.length ? " " + args.join(" ") : ""} ==`);
  const { status } = spawnSync(
    wdio,
    ["run", join(here, "wdio.conf.js"), "--spec", join(dir, "*.spec.js")],
    {
      stdio: "inherit",
      shell: win, // .cmd shims need a shell
      env: { ...process.env, JOTTER_DATA_DIR: dataDir, JOTTER_E2E_ARGS: JSON.stringify(args) },
    },
  );
  // A launch whose spec quits the app cannot report cleanly: the session dies
  // with the process it was driving. Such a folder holds nothing but the quit,
  // and what the quit had to write is asserted by the launch after it.
  if (status !== 0) {
    if (meta.quits) console.log(`(${group} quit the app, as it is meant to)`);
    else failed += 1;
  }
}
process.exit(failed ? 1 : 0);
