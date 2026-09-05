// Quit while typing: the one flow that has to end with a dead app.
//
// The keystroke and the quit leave in a single round trip, so the quit reaches
// the host inside the 400ms autosave debounce. Nothing has written the text
// when the app is asked to go; if launch-6 finds it in the store, the host held
// the quit open for the page's last save. Letting the WebDriver session end on
// its own instead loses the text, so the service's teardown is not this test.
//
// There is nothing to assert here — launch-6 does that — and the run this spec
// belongs to cannot report cleanly, because its session dies with the app.
// `launch.json` says `quits`, which is how run.js knows to expect that.

import { browser, $ } from "@wdio/globals";
import { sleep } from "../../helpers.js";

const LAST_LINE = "typed with no time to autosave";

describe("quitting while typing", () => {
  it("asks the app to quit one keystroke after typing", async () => {
    await $("#editor").waitForExist();
    await browser.execute((line) => {
      const editor = document.getElementById("editor");
      editor.value = line;
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      window.__TAURI_INTERNALS__.invoke("plugin:process|exit", { code: 0 });
    }, LAST_LINE);
    await sleep(2_000); // let the host finish before the folder ends
  });
});
