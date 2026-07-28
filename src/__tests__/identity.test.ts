import { describe, expect, test } from "bun:test";

import { normalizeHandle, resolveIdentity } from "../channel/identity.ts";

describe("normalizeHandle", () => {
  test("passes through E.164", () => {
    expect(normalizeHandle("+15551234567")).toBe("+15551234567");
  });

  test("collapses the formats one human arrives as", () => {
    // The whole point: these must all be the same identity, or the same
    // person gets several contact records and several trust classifications.
    const forms = [
      "+15551234567",
      "15551234567",
      "5551234567",
      "(555) 123-4567",
      "555-123-4567",
      "555.123.4567",
      " +1 555 123 4567 ",
      "0015551234567",
      "01115551234567",
    ];
    const normalized = new Set(forms.map((f) => normalizeHandle(f)));
    expect(normalized).toEqual(new Set(["+15551234567"]));
  });

  test("what follows an international access prefix is a country code", () => {
    // `011` and `00` are dial-out prefixes, so the digits after them are
    // already country-coded. Re-applying the default country code here would
    // rewrite a foreign number into a domestic one.
    expect(normalizeHandle("011442071838750")).toBe("+442071838750");
    expect(normalizeHandle("00442071838750")).toBe("+442071838750");
  });

  test("keeps a non-US country code intact", () => {
    expect(normalizeHandle("+442071838750")).toBe("+442071838750");
    expect(normalizeHandle("00442071838750")).toBe("+442071838750");
  });

  test("rejects short codes so they never become contact identities", () => {
    expect(normalizeHandle("262966")).toBeUndefined();
    expect(normalizeHandle("40404")).toBeUndefined();
  });

  test("rejects ambiguous digit counts rather than guessing a country", () => {
    expect(normalizeHandle("5551234")).toBeUndefined();
    expect(normalizeHandle("225551234567")).toBeUndefined();
  });

  test("rejects over-long numbers", () => {
    expect(normalizeHandle("+1234567890123456")).toBeUndefined();
  });

  test("lowercases a plausible Apple ID and rejects junk", () => {
    expect(normalizeHandle("Person@iCloud.com")).toBe("person@icloud.com");
    expect(normalizeHandle("not-an-email@")).toBeUndefined();
  });

  test("rejects empty and non-numeric input", () => {
    expect(normalizeHandle(undefined)).toBeUndefined();
    expect(normalizeHandle("")).toBeUndefined();
    expect(normalizeHandle("   ")).toBeUndefined();
    expect(normalizeHandle("call me")).toBeUndefined();
  });
});

describe("resolveIdentity", () => {
  test("keeps actor and conversation distinct when both are supplied", () => {
    const identity = resolveIdentity({
      from: "(555) 123-4567",
      conversationId: "conv_abc",
    });
    expect(identity).toEqual({
      actorExternalId: "+15551234567",
      conversationExternalId: "conv_abc",
    });
  });

  test("falls back to the handle as the conversation address", () => {
    const identity = resolveIdentity({
      from: "+15551234567",
      conversationId: undefined,
    });
    expect(identity?.conversationExternalId).toBe("+15551234567");
    expect(identity?.actorExternalId).toBe("+15551234567");
  });

  test("drops a message with no attributable sender", () => {
    // Fail closed: an unattributable message cannot be trust-classified, and
    // admitting it under a placeholder actor would be worse than losing it.
    expect(
      resolveIdentity({ from: undefined, conversationId: "conv_abc" }),
    ).toBeUndefined();
    expect(
      resolveIdentity({ from: "garbage", conversationId: "conv_abc" }),
    ).toBeUndefined();
  });
});
