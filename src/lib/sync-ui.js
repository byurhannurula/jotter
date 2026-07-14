// Pure decision helpers for the Cloud settings token field + status pill, split
// out of renderSyncSection so they're unit-testable without a DOM.

export const TOKEN_MASK = "•".repeat(28); // solid dots shown for a stored token

/** True when the field holds a real user-entered token (not blank or the mask). */
export function isTypedToken(value) {
  const v = (value || "").trim();
  return !!v && v !== TOKEN_MASK;
}

/**
 * What set_sync_config should receive for the token: the typed value, or null to
 * keep the stored token (a blank or masked field must not wipe it).
 */
export function tokenToSave(value) {
  return isTypedToken(value) ? value.trim() : null;
}

/** Resting status pill from config + this session's verify result. */
export function pillState({ url, hasToken, typedToken, verifiedOk }) {
  if (verifiedOk) return { label: "Connected", kind: "ok" };
  const configured = !!(url && url.trim()) && (hasToken || typedToken);
  return configured ? { label: "Configured", kind: "set" } : { label: "Not configured", kind: "" };
}

/** Map a sync_test_connection result to a pill state. */
export function verifyResultToPill(r) {
  if (r.ok) return { label: "Connected" + (r.version ? ` · v${r.version}` : ""), kind: "ok" };
  if (r.status === 401) {
    // `configured === false` means the worker itself has no SYNC_TOKEN set (it
    // fails closed), so the fix is on the worker, not the user's token.
    return r.configured === false
      ? { label: "Worker has no token set", kind: "err" }
      : { label: "Invalid token", kind: "err" };
  }
  return { label: `Error ${r.status}`, kind: "err" };
}
