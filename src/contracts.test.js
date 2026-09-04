// Facts that live in two languages and drift silently: read both files and
// compare. None of these can be shared at runtime, so a test is the guard.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const css = read("src/styles.css");
const rust = read("src-tauri/src/lib.rs");
const mainJs = read("src/main.js");
const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
const html = read("src/index.html");

describe("title bar height", () => {
  it("is the same in CSS and in the traffic-light maths", () => {
    const cssPx = Number(css.match(/--titlebar-h:\s*(\d+)px/)[1]);
    const rustPx = Number(rust.match(/const TITLEBAR_H: f64 = ([\d.]+);/)[1]);
    expect(rustPx).toBe(cssPx);
  });
});

describe("minimum window size", () => {
  it("is the same in tauri.conf.json and in the window restore clamp", () => {
    const win = conf.app.windows[0];
    expect(Number(rust.match(/const MIN_W: f64 = ([\d.]+);/)[1])).toBe(win.minWidth);
    expect(Number(rust.match(/const MIN_H: f64 = ([\d.]+);/)[1])).toBe(win.minHeight);
  });
});

describe("text file extensions", () => {
  it("are the same set in the open dialog and in the OS file associations", () => {
    const exts = JSON.parse(`[${mainJs.match(/const TEXT_EXTS = \[([^\]]*)\]/)[1]}]`);
    const assoc = conf.bundle.fileAssociations.flatMap((a) => a.ext);
    expect([...exts].sort()).toEqual([...new Set(assoc)].sort());
  });
});

describe("Draft shape", () => {
  it("matches between createBlankDraft and struct Draft", () => {
    const literal = mainJs.match(
      /function createBlankDraft\(\) \{[\s\S]*?const d = \{([\s\S]*?)\};/,
    )[1];
    const jsKeys = [...literal.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
    const body = rust.match(/\nstruct Draft \{([\s\S]*?)\n\}/)[1];
    const fields = [];
    let defaulted = false;
    for (const line of body.split("\n")) {
      if (/serde\(default\)/.test(line)) defaulted = true;
      const m = line.match(/^\s*(\w+):/);
      if (m) {
        fields.push({ name: m[1], defaulted });
        defaulted = false;
      }
    }
    const names = fields.map((f) => f.name);
    for (const k of jsKeys) expect(names, `JS writes ${k}`).toContain(k);
    // A Rust field the blank draft does not write must be optional on read.
    for (const f of fields) {
      if (!jsKeys.includes(f.name))
        expect(f.defaulted, `${f.name} needs #[serde(default)]`).toBe(true);
    }
  });
});

describe("theme blocks", () => {
  const block = (header) => {
    const start = css.indexOf(header);
    expect(start, header).toBeGreaterThan(-1);
    const end = css.indexOf("\n}", start);
    return new Set([...css.slice(start, end).matchAll(/--([a-z-]+):/g)].map((m) => m[1]));
  };
  it("define the same tokens in the dark media block and both explicit themes", () => {
    const root = block(":root {");
    const dark = block('html[data-theme="dark"] {');
    const light = block('html[data-theme="light"] {');
    const media = block("@media (prefers-color-scheme: dark) {");
    expect([...light].sort()).toEqual([...dark].sort());
    expect([...media].sort()).toEqual([...dark].sort());
    for (const t of dark) expect(root.has(t), `--${t} has no :root default`).toBe(true);
  });
});

describe("the shipped style-src", () => {
  const csp = conf.app.security.csp;

  it("has no 'unsafe-inline', so the page must carry no inline style", () => {
    expect(csp).toContain("style-src 'self'");
    expect(csp).not.toContain("style-src 'self' 'unsafe-inline'");
    // A `style=` attribute or a <style> block in the page is refused outright
    // by that policy — and only in a release build, where the dev server's
    // looser policy is gone, so nothing in `pnpm tauri dev` would show it.
    // Styling from JS goes through the CSSOM (`el.style.x = ...`), which the
    // policy does not police.
    expect(html).not.toMatch(/\sstyle="/);
    expect(html).not.toMatch(/<style[\s>]/);
  });

  it("renders markdown with raw HTML off, so a note cannot carry one either", () => {
    expect(mainJs).toMatch(/new MarkdownIt\(\{[^}]*html:\s*false/);
  });
});
