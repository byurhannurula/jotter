import { describe, it, expect } from "vitest";
import { reconcileDrafts } from "./sync-reconcile.js";

// Build a draft with sensible defaults.
const d = (id, over = {}) => ({ id, content: "", file_path: null, updated_at: 0, ...over });
const model = (...drafts) => new Map(drafts.map((x) => [x.id, x]));

describe("reconcileDrafts", () => {
  it("adds a draft that isn't in the model yet", () => {
    const store = [d("a", { content: "new", updated_at: 5 })];
    const { updates, removals, editorContent } = reconcileDrafts(store, model(), null, "");
    expect(updates.map((u) => u.id)).toEqual(["a"]);
    expect(removals).toEqual([]);
    expect(editorContent).toBeNull();
  });

  it("adopts a strictly-newer remote draft", () => {
    const store = [d("a", { content: "remote", updated_at: 10 })];
    const cur = model(d("a", { content: "local", updated_at: 5 }));
    const { updates } = reconcileDrafts(store, cur, null, "");
    expect(updates).toHaveLength(1);
    expect(updates[0].content).toBe("remote");
  });

  it("skips a remote draft that is same-age or older", () => {
    const store = [d("a", { content: "remote", updated_at: 5 })];
    const cur = model(d("a", { content: "local", updated_at: 5 }));
    const { updates } = reconcileDrafts(store, cur, null, "");
    expect(updates).toEqual([]);
  });

  it("keeps the device-local file_path when adopting a newer draft", () => {
    const store = [d("a", { content: "remote", updated_at: 10, file_path: null })];
    const cur = model(d("a", { content: "local", updated_at: 5, file_path: "/tmp/a.md" }));
    const { updates } = reconcileDrafts(store, cur, null, "");
    expect(updates[0].file_path).toBe("/tmp/a.md");
  });

  it("does NOT clobber the active draft while it has unsaved edits", () => {
    const store = [d("a", { content: "remote", updated_at: 10 })];
    const cur = model(d("a", { content: "saved", updated_at: 5 }));
    // editor holds newer text than the model's known content -> mid-edit.
    const { updates, editorContent } = reconcileDrafts(store, cur, "a", "user typing…");
    expect(updates).toEqual([]);
    expect(editorContent).toBeNull();
  });

  it("adopts into the active draft when the editor is clean", () => {
    const store = [d("a", { content: "remote", updated_at: 10 })];
    const cur = model(d("a", { content: "saved", updated_at: 5 }));
    const { updates, editorContent } = reconcileDrafts(store, cur, "a", "saved");
    expect(updates).toHaveLength(1);
    expect(editorContent).toBe("remote");
  });

  it("removes a persisted in-app draft that vanished from the store", () => {
    const cur = model(d("gone", { content: "had text", updated_at: 5 }));
    const { removals } = reconcileDrafts([], cur, null, "");
    expect(removals).toEqual(["gone"]);
  });

  it("keeps an unsaved blank draft that isn't in the store", () => {
    const cur = model(d("blank", { content: "   ", updated_at: 5 }));
    const { removals } = reconcileDrafts([], cur, null, "");
    expect(removals).toEqual([]);
  });

  it("keeps a file-backed draft that isn't in the store", () => {
    const cur = model(d("file", { content: "x", updated_at: 5, file_path: "/tmp/x.md" }));
    const { removals } = reconcileDrafts([], cur, null, "");
    expect(removals).toEqual([]);
  });

  it("never removes the active draft", () => {
    const cur = model(d("a", { content: "text", updated_at: 5 }));
    const { removals } = reconcileDrafts([], cur, "a", "text");
    expect(removals).toEqual([]);
  });
});
