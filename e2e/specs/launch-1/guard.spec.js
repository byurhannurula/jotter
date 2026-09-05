// The two host-side guards that only a real build can show: the path
// allow-list in `lib.rs`, and the shipped CSP. Neither exists in happy-dom —
// there the IPC is a stub and there is no policy at all — and the CSP the dev
// server serves is the looser `devCsp`, so a dev run cannot prove this either.
//
// Nothing here leaves a draft or a file behind, so it can share the first
// launch with write.spec.js (which runs after it: g sorts before w).

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { browser, $, expect } from "@wdio/globals";
import { dataDir, hostInvoke, storedDrafts, DENIED } from "../../helpers.js";

// Written from the test side, so it exists on disk but the user never chose it
// in the app. That is exactly the file the guard has to refuse.
const unopened = () => join(dataDir(), "never-opened.txt");

describe("what the page may touch on disk", () => {
  before(async () => {
    await $("#editor").waitForExist();
    writeFileSync(unopened(), "not for the page");
    mkdirSync(join(dataDir(), "sub"), { recursive: true });
  });

  it("refuses to read a file outside the app", async () => {
    const r = await hostInvoke("read_text_file", { path: "/etc/hosts" });
    expect(r.ok).toBe(false);
    expect(r.err).toContain(DENIED);
  });

  it("refuses to read a file in its own data folder that the user never opened", async () => {
    const r = await hostInvoke("read_text_file", { path: unopened() });
    expect(r.ok).toBe(false);
    expect(r.err).toContain(DENIED);
  });

  it("refuses a path dressed up with . and .., and writes nothing", async () => {
    const dodged = `${dataDir()}/sub/../never-opened.txt`;
    const r = await hostInvoke("read_text_file", { path: dodged });
    expect(r.ok).toBe(false);
    expect(r.err).toContain(DENIED);
  });

  it("refuses to write a file the user never picked", async () => {
    const target = join(dataDir(), "planted.txt");
    const r = await hostInvoke("write_text_file", { path: target, contents: "planted" });
    expect(r.ok).toBe(false);
    expect(r.err).toContain(DENIED);
    expect(existsSync(target)).toBe(false);
  });

  it("refuses to park a conflicted copy beside a file the user never picked", async () => {
    const r = await hostInvoke("write_conflict_copy", {
      path: unopened(),
      contents: "planted",
    });
    expect(r.ok).toBe(false);
    expect(r.err).toContain(DENIED);
    expect(existsSync(join(dataDir(), "never-opened (conflicted copy).txt"))).toBe(false);
  });

  it("refuses to save a draft that names a file the user never picked", async () => {
    const r = await hostInvoke("save_draft", {
      draft: {
        id: "planted-draft",
        title: "planted",
        content: "planted",
        file_path: unopened(),
        created_at: Date.now(),
        updated_at: Date.now(),
      },
    });
    expect(r.ok).toBe(false);
    expect(r.err).toContain(DENIED);
    expect(storedDrafts().map((d) => d.id)).not.toContain("planted-draft");
  });
});

describe("the shipped content security policy", () => {
  it("is enforced, not just configured", async () => {
    // Delivered as a header, not a <meta>: reading it back is not an option,
    // so each rule is tested by trying the thing it forbids.
    const out = await browser.execute(async () => {
      const r = {};

      const style = document.createElement("style");
      style.textContent = "#editor{display:none}";
      document.head.append(style);
      r.styleApplied = getComputedStyle(document.getElementById("editor")).display === "none";
      style.remove();

      const script = document.createElement("script");
      script.textContent = "window.__cspProbe = 1";
      document.head.append(script);
      r.scriptRan = window.__cspProbe === 1;
      script.remove();
      delete window.__cspProbe;

      try {
        await fetch("https://example.com/");
        r.fetchAllowed = true;
      } catch {
        r.fetchAllowed = false;
      }
      return r;
    });

    expect(out.styleApplied).toBe(false); // style-src 'self': no inline <style>
    expect(out.scriptRan).toBe(false); // script-src 'self': no inline <script>
    expect(out.fetchAllowed).toBe(false); // connect-src: nowhere but ipc
  });
});
