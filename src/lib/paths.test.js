import { describe, it, expect } from "vitest";
import { dirName, tildePath, shortPath } from "./paths.js";

const HOME = "/Users/me";

describe("dirName", () => {
  it("drops the file name", () => {
    expect(dirName("/Users/me/Notes/todo.md")).toBe("/Users/me/Notes");
    expect(dirName("C:\\Users\\me\\todo.md")).toBe("C:\\Users\\me");
  });
  it("returns a bare name unchanged", () => {
    expect(dirName("todo.md")).toBe("todo.md");
  });
});

describe("tildePath", () => {
  it("replaces the home folder with ~", () => {
    expect(tildePath("/Users/me/Notes", HOME)).toBe("~/Notes");
    expect(tildePath("/Users/me", HOME)).toBe("~");
  });
  it("leaves paths outside home alone", () => {
    expect(tildePath("/Volumes/USB/Notes", HOME)).toBe("/Volumes/USB/Notes");
    expect(tildePath("/Users/meow/Notes", HOME)).toBe("/Users/meow/Notes");
  });
  it("leaves Windows paths alone", () => {
    expect(tildePath("C:\\Users\\me\\Notes", "C:\\Users\\me")).toBe("C:\\Users\\me\\Notes");
  });
  it("does nothing without a home", () => {
    expect(tildePath("/Users/me/Notes", "")).toBe("/Users/me/Notes");
  });
});

describe("shortPath", () => {
  it("returns a short path whole", () => {
    expect(shortPath("/Users/me/Notes", HOME)).toBe("~/Notes");
  });
  it("cuts a long path in the middle and keeps the root", () => {
    const p = "/Volumes/External Drive/Archive/Projects/2026/Jotter/Notes";
    const out = shortPath(p, HOME, 30);
    expect(out.startsWith("/…/")).toBe(true);
    expect(out.endsWith("/Jotter/Notes")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(30);
  });
  it("keeps at least the last folder even when it alone is too long", () => {
    const p = "/a/b/c/an-extraordinarily-long-folder-name-here";
    expect(shortPath(p, HOME, 20)).toBe("/…/an-extraordinarily-long-folder-name-here");
  });
  it("keeps the drive on Windows and both slashes on UNC", () => {
    expect(shortPath("C:\\Users\\me\\Documents\\Work\\Jotter\\Notes", "", 24)).toBe(
      "C:\\…\\Work\\Jotter\\Notes",
    );
    expect(shortPath("\\\\server\\share\\Documents\\Work\\Jotter\\Notes", "", 24)).toBe(
      "\\\\…\\Work\\Jotter\\Notes",
    );
  });
  it("never shows an ellipsis that hides nothing", () => {
    expect(shortPath("/short-but-over-the-limit", HOME, 10)).toBe("/short-but-over-the-limit");
  });
});
