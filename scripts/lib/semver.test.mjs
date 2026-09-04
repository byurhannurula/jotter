import { describe, it, expect } from "vitest";
import { bumpVersion, setVersion, VERSION_FILES } from "./semver.mjs";

describe("bumpVersion", () => {
  it("bumps each part and resets the ones below it", () => {
    expect(bumpVersion("0.4.0", "patch")).toBe("0.4.1");
    expect(bumpVersion("0.4.3", "minor")).toBe("0.5.0");
    expect(bumpVersion("0.4.3", "major")).toBe("1.0.0");
  });
  it("refuses a version that is not x.y.z, or an unknown kind", () => {
    expect(() => bumpVersion("1.2", "patch")).toThrow("not a x.y.z");
    expect(() => bumpVersion("1.2.x", "patch")).toThrow("not a x.y.z");
    expect(() => bumpVersion("1.2.3", "huge")).toThrow("unknown bump");
  });
});

describe("setVersion", () => {
  it("rewrites the version in every file shape the app has", () => {
    const samples = {
      "package.json": '{\n  "name": "jotter",\n  "version": "0.4.0",\n}',
      "src-tauri/tauri.conf.json": '{\n  "productName": "Jotter",\n  "version": "0.4.0",\n}',
      "src-tauri/Cargo.toml": '[package]\nname = "jotter"\nversion = "0.4.0"\nedition = "2021"\n',
      "src/lib/meta.js": 'export const APP = {\n  name: "Jotter",\n  version: "0.4.0",\n};\n',
    };
    for (const [file, re] of VERSION_FILES) {
      const out = setVersion(samples[file], re, "0.5.0", file);
      expect(out).toContain("0.5.0");
      expect(out).not.toContain("0.4.0");
    }
  });
  it("throws when the pattern is missing, so a moved field cannot go unbumped", () => {
    expect(() => setVersion("nothing here", VERSION_FILES[0][1], "1.0.0", "x")).toThrow("x");
  });
});
