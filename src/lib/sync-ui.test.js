import { describe, it, expect } from "vitest";
import {
  TOKEN_MASK,
  isTypedToken,
  tokenToSave,
  pillState,
  verifyResultToPill,
} from "./sync-ui.js";

describe("isTypedToken", () => {
  it("is true for a real value", () => expect(isTypedToken("abc123")).toBe(true));
  it("is false for blank/whitespace", () => {
    expect(isTypedToken("")).toBe(false);
    expect(isTypedToken("   ")).toBe(false);
    expect(isTypedToken(null)).toBe(false);
  });
  it("is false for the masked placeholder", () => expect(isTypedToken(TOKEN_MASK)).toBe(false));
});

describe("tokenToSave", () => {
  it("returns the trimmed typed value", () => expect(tokenToSave("  tok  ")).toBe("tok"));
  it("returns null for blank or masked (keep the stored token)", () => {
    expect(tokenToSave("")).toBeNull();
    expect(tokenToSave(TOKEN_MASK)).toBeNull();
  });
});

describe("pillState", () => {
  it("shows Connected once verified this session", () => {
    expect(pillState({ url: "https://x", hasToken: true, typedToken: false, verifiedOk: true }))
      .toEqual({ label: "Connected", kind: "ok" });
  });
  it("shows Configured when a url + stored token exist", () => {
    expect(pillState({ url: "https://x", hasToken: true, typedToken: false, verifiedOk: false }))
      .toEqual({ label: "Configured", kind: "set" });
  });
  it("shows Configured when a url + freshly-typed token exist", () => {
    expect(pillState({ url: "https://x", hasToken: false, typedToken: true, verifiedOk: false }))
      .toEqual({ label: "Configured", kind: "set" });
  });
  it("shows Not configured without a url", () => {
    expect(pillState({ url: "", hasToken: true, typedToken: false, verifiedOk: false }))
      .toEqual({ label: "Not configured", kind: "" });
  });
  it("shows Not configured without any token", () => {
    expect(pillState({ url: "https://x", hasToken: false, typedToken: false, verifiedOk: false }))
      .toEqual({ label: "Not configured", kind: "" });
  });
});

describe("verifyResultToPill", () => {
  it("Connected with version on success", () => {
    expect(verifyResultToPill({ ok: true, status: 200, version: "0.1.1" }))
      .toEqual({ label: "Connected · v0.1.1", kind: "ok" });
  });
  it("Connected without version", () => {
    expect(verifyResultToPill({ ok: true, status: 200 }))
      .toEqual({ label: "Connected", kind: "ok" });
  });
  it("Invalid token on 401", () => {
    expect(verifyResultToPill({ ok: false, status: 401 }))
      .toEqual({ label: "Invalid token", kind: "err" });
  });
  it("Error <status> otherwise", () => {
    expect(verifyResultToPill({ ok: false, status: 500 }))
      .toEqual({ label: "Error 500", kind: "err" });
  });
});
