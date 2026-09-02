import { describe, it, expect } from "vitest";
import {
  baseName,
  firstLine,
  draftTitle,
  draftPreview,
  isEmpty,
  relTime,
  findMatches,
  indentEdit,
} from "./text.js";

describe("baseName", () => {
  it("returns the file name for posix and windows paths", () => {
    expect(baseName("/Users/x/notes/todo.txt")).toBe("todo.txt");
    expect(baseName("C:\\a\\b.md")).toBe("b.md");
  });
  it("returns null for empty input", () => {
    expect(baseName(null)).toBe(null);
    expect(baseName("")).toBe(null);
  });
});

describe("firstLine", () => {
  it("skips leading blank lines", () => {
    expect(firstLine("\n\n  hello\nworld")).toBe("hello");
  });
  it("returns empty for blank content", () => {
    expect(firstLine("   \n  ")).toBe("");
  });
});

describe("draftTitle", () => {
  it("prefers a user-set title (Rename) over everything", () => {
    expect(draftTitle({ title: "My Notes", file_path: "/a/report.txt", content: "hi" })).toBe(
      "My Notes",
    );
    expect(draftTitle({ title: "  ", file_path: null, content: "first line" })).toBe("first line"); // blank title is ignored
  });
  it("prefers the file name", () => {
    expect(draftTitle({ file_path: "/a/report.txt", content: "hi" })).toBe("report.txt");
  });
  it("falls back to the first line", () => {
    expect(draftTitle({ file_path: null, content: "My idea\nmore" })).toBe("My idea");
  });
  it("falls back to New Draft when blank", () => {
    expect(draftTitle({ file_path: null, content: "" })).toBe("New Draft");
  });
  it("truncates the first line to 60 chars", () => {
    expect(draftTitle({ file_path: null, content: "x".repeat(100) }).length).toBe(60);
  });
});

describe("draftPreview", () => {
  it("joins the lines after the first", () => {
    expect(draftPreview({ content: "Title\nsecond line\nthird" })).toBe("second line third");
  });
  it("is empty for single-line content", () => {
    expect(draftPreview({ content: "only line" })).toBe("");
  });
});

describe("isEmpty", () => {
  it("is true for blank text and no file", () => {
    expect(isEmpty({ content: "  \n ", file_path: null })).toBe(true);
  });
  it("is false when it has a file path", () => {
    expect(isEmpty({ content: "", file_path: "/a.txt" })).toBe(false);
  });
  it("is false when it has text", () => {
    expect(isEmpty({ content: "x", file_path: null })).toBe(false);
  });
});

describe("isEmpty", () => {
  const d = (over = {}) => ({ content: "", file_path: null, title: "", ...over });

  it("is empty with no text, file, or name", () => {
    expect(isEmpty(d())).toBe(true);
    expect(isEmpty(d({ content: "   \n " }))).toBe(true);
  });

  it("is not empty once there is text", () => {
    expect(isEmpty(d({ content: "hi" }))).toBe(false);
  });

  it("is not empty when a file backs it", () => {
    expect(isEmpty(d({ file_path: "/tmp/a.txt" }))).toBe(false);
  });

  it("is not empty when the user has named it", () => {
    // A renamed draft that was later cleared is still deliberate; pruning it
    // on the next launch would lose it.
    expect(isEmpty(d({ title: "Shopping" }))).toBe(false);
    expect(isEmpty(d({ title: "   " }))).toBe(true);
  });
});

describe("relTime", () => {
  const now = 1_000_000_000_000;
  it("says 'now' under a minute", () => expect(relTime(now - 30_000, now)).toBe("now"));
  it("formats minutes", () => expect(relTime(now - 5 * 60_000, now)).toBe("5m"));
  it("formats hours", () => expect(relTime(now - 3 * 3_600_000, now)).toBe("3h"));
  it("formats days", () => expect(relTime(now - 2 * 86_400_000, now)).toBe("2d"));
  it("formats weeks", () => expect(relTime(now - 14 * 86_400_000, now)).toBe("2w"));
  it("is empty for a falsy timestamp", () => expect(relTime(0, now)).toBe(""));
});

describe("findMatches", () => {
  it("finds all case-insensitive matches", () => {
    expect(findMatches("aAaA", "a")).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
    ]);
  });
  it("respects case sensitivity", () => {
    expect(findMatches("aAaA", "A", true)).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });
  it("steps past each match (no overlap)", () => {
    expect(findMatches("aaaa", "aa")).toEqual([
      [0, 2],
      [2, 4],
    ]);
  });
  it("returns nothing for an empty query", () => {
    expect(findMatches("abc", "")).toEqual([]);
  });
});

describe("indentEdit", () => {
  /** Apply an edit the way the editor does, so tests read as before/after text. */
  const apply = (text, edit) =>
    edit === null ? text : text.slice(0, edit.from) + edit.text + text.slice(edit.to);

  it("inserts one unit at a caret", () => {
    const edit = indentEdit("ab", 1, 1, "  ");
    expect(apply("ab", edit)).toBe("a  b");
    expect(edit.selStart).toBe(3);
    expect(edit.selEnd).toBe(3);
  });

  it("replaces a within-one-line selection, like a normal keystroke", () => {
    const edit = indentEdit("abcd", 1, 3, "\t");
    expect(apply("abcd", edit)).toBe("a\td");
  });

  it("indents every line of a multi-line selection", () => {
    const text = "one\ntwo\nthree";
    expect(apply(text, indentEdit(text, 1, 9, "  "))).toBe("  one\n  two\n  three");
  });

  it("leaves blank lines inside a block unindented", () => {
    const text = "one\n\ntwo";
    expect(apply(text, indentEdit(text, 0, 8, "  "))).toBe("  one\n\n  two");
  });

  it("does not pull in the next line when the selection ends at a line start", () => {
    const text = "one\ntwo\nthree";
    expect(apply(text, indentEdit(text, 0, 4, "  "))).toBe("  one\ntwo\nthree");
  });

  it("outdents the current line with no selection", () => {
    const text = "\t\tdeep";
    expect(apply(text, indentEdit(text, 4, 4, "\t", true))).toBe("\tdeep");
  });

  it("removes a tab-width of spaces when the unit is a tab", () => {
    const text = "      six";
    expect(apply(text, indentEdit(text, 0, 0, "\t", true))).toBe("  six");
  });

  it("removes only what is there, per line", () => {
    const text = "    four\n  two\nnone";
    expect(apply(text, indentEdit(text, 0, 18, "    ", true))).toBe("four\ntwo\nnone");
  });

  it("returns null when outdenting changes nothing", () => {
    expect(indentEdit("flush\nleft", 0, 10, "  ", true)).toBe(null);
  });

  it("keeps the selection over the same text after indenting", () => {
    const text = "one\ntwo";
    const edit = indentEdit(text, 0, 7, "  ");
    expect(edit.selStart).toBe(0);
    expect(apply(text, edit).slice(edit.selStart, edit.selEnd)).toBe("  one\n  two");
  });

  it("never lets an outdent push the selection before the line start", () => {
    const text = "    indented";
    const edit = indentEdit(text, 0, 0, "    ", true);
    expect(edit.selStart).toBe(0);
  });
});
