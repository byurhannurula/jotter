// End-to-end suite: the real app, built with the `e2e` Cargo feature, driven
// through the embedded WebDriver server. Build first:
//
//   pnpm e2e:build      (tauri build --debug --no-bundle --features e2e)
//   pnpm e2e            (see run.js: one app launch per specs/launch-* folder)
//
// JOTTER_DATA_DIR points the app at a throwaway folder, so the suite never
// sees or touches the notes of whoever runs it. JOTTER_E2E_ARGS is the JSON
// list of command-line arguments for this launch.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bin = process.platform === "win32" ? "jotter.exe" : "jotter";
const appBinaryPath = join(import.meta.dirname, "..", "src-tauri", "target", "debug", bin);
const appArgs = JSON.parse(process.env.JOTTER_E2E_ARGS ?? "[]");

process.env.JOTTER_DATA_DIR ??= mkdtempSync(join(tmpdir(), "jotter-e2e-"));

export const config = {
  runner: "local",
  specs: ["./specs/launch-1/*.spec.js"],
  maxInstances: 1,
  services: [["@wdio/tauri-service", { appBinaryPath, driverProvider: "embedded", appArgs }]],
  capabilities: [
    { browserName: "tauri", "tauri:options": { application: appBinaryPath, args: appArgs } },
  ],
  logLevel: "warn",
  outputDir: join(import.meta.dirname, "logs"),
  bail: 0,
  waitforTimeout: 10_000,
  connectionRetryTimeout: 90_000,
  connectionRetryCount: 3,
  framework: "mocha",
  mochaOpts: { ui: "bdd", timeout: 60_000 },

  // Nothing here raises the app window. WKWebView stops servicing
  // requestAnimationFrame while the window is behind another one, and the app
  // draws tab titles and sidebar rows from one — but stealing the front every
  // few seconds makes the machine unusable while the suite runs. The specs
  // call `settle()` instead, which draws that frame on demand through the E2E
  // build's hook, so a run can share a desktop with whoever started it.

  /** On a failure, keep a screenshot and print what the page looked like. */
  async afterTest(test, _context, { passed }) {
    if (passed) return;
    const name = `${test.parent} ${test.title}`.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    await browser.saveScreenshot(join(import.meta.dirname, "logs", `${name}.png`));
    const state = await browser.execute(() => ({
      body: document.body.className,
      editor: document.getElementById("editor")?.value,
      tabs: [...document.querySelectorAll("#tabs .tab")].map((t) => t.textContent.trim()),
      toasts: [...document.querySelectorAll("#toast-host .toast")].map((t) => t.textContent.trim()),
      menu: [...document.querySelectorAll("#context-menu .context-item")].map((b) =>
        b.textContent.trim(),
      ),
      active: document.activeElement?.id || document.activeElement?.tagName,
    }));
    console.log(`state after "${test.title}":`, JSON.stringify(state));
  },
};
