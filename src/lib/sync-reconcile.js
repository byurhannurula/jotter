import { isEmpty } from "./text.js";

/**
 * Decide how to reconcile the on-disk store into the in-memory model after a sync,
 * without touching the DOM. Conservative on deletes: only drops persisted in-app
 * drafts (no file_path) that vanished from the store. Pure — unit-tested.
 *
 * @param {Array} storeList  drafts from list_drafts: {id, content, updated_at, file_path}
 * @param {Map} model        id -> draft currently in memory
 * @param {string|null} currentId  the active draft (its unsaved edits must not be clobbered)
 * @param {string} editorValue     current editor text (detects an unsaved active edit)
 * @returns {{updates: Array, removals: string[], editorContent: string|null}}
 *   updates  — drafts to set into the model
 *   removals — ids to drop from the view (remotely deleted)
 *   editorContent — new text for the active draft, or null to leave the editor alone
 */
export function reconcileDrafts(storeList, model, currentId, editorValue) {
  const store = new Map(storeList.map((d) => [d.id, d]));
  const updates = [];
  let editorContent = null;

  // Store -> model: add new drafts, adopt strictly-newer ones.
  for (const [id, sd] of store) {
    const cur = model.get(id);
    if (!cur) {
      updates.push(sd);
      continue;
    }
    if (sd.updated_at <= cur.updated_at) continue; // ours is same or newer
    if (id === currentId) {
      // Only adopt if the editor isn't mid-edit (still matches the known content).
      if (editorValue === cur.content) {
        updates.push(sd);
        editorContent = sd.content;
      }
    } else {
      updates.push({ ...sd, file_path: cur.file_path ?? sd.file_path });
    }
  }

  // Remote deletions: a persisted in-app draft that vanished from the store.
  const removals = [];
  for (const [id, d] of model) {
    if (store.has(id) || id === currentId) continue;
    if (isEmpty(d) || d.file_path) continue; // unsaved blank or file-backed: leave it
    removals.push(id);
  }

  return { updates, removals, editorContent };
}
