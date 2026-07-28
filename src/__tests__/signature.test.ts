import { createHmac } from "node:crypto";

import { describe, expect, test } from "bun:test";

import {
  MAX_TIMESTAMP_SKEW_SECONDS,
  parseSignatureHeader,
  verifyWebhookSignature,
} from "../comms/signature.ts";

const SECRET = "whsec_test";
const BODY = '{"event":"message.received"}';
const NOW = 1_800_000_000;

function sign(body: string, timestamp: number, secret = SECRET): string {
  const digest = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

describe("verifyWebhookSignature", () => {
  test("accepts a correct signature", () => {
    const result = verifyWebhookSignature({
      rawBody: BODY,
      signatureHeader: sign(BODY, NOW),
      secret: SECRET,
      nowSeconds: NOW,
    });
    expect(result.ok).toBe(true);
  });

  test("rejects when no secret is stored", () => {
    // The load-bearing case: webhook mode with no secret must not silently
    // become an unauthenticated inbound-message endpoint.
    const result = verifyWebhookSignature({
      rawBody: BODY,
      signatureHeader: sign(BODY, NOW),
      secret: undefined,
      nowSeconds: NOW,
    });
    expect(result.ok).toBe(false);
  });

  test("rejects a missing header", () => {
    const result = verifyWebhookSignature({
      rawBody: BODY,
      signatureHeader: null,
      secret: SECRET,
      nowSeconds: NOW,
    });
    expect(result.ok).toBe(false);
  });

  test("rejects a signature made with the wrong secret", () => {
    const result = verifyWebhookSignature({
      rawBody: BODY,
      signatureHeader: sign(BODY, NOW, "whsec_other"),
      secret: SECRET,
      nowSeconds: NOW,
    });
    expect(result.ok).toBe(false);
  });

  test("rejects a tampered body", () => {
    const result = verifyWebhookSignature({
      rawBody: '{"event":"message.received","injected":true}',
      signatureHeader: sign(BODY, NOW),
      secret: SECRET,
      nowSeconds: NOW,
    });
    expect(result.ok).toBe(false);
  });

  test("rejects a replayed delivery outside the window", () => {
    const stale = NOW - MAX_TIMESTAMP_SKEW_SECONDS - 1;
    const result = verifyWebhookSignature({
      rawBody: BODY,
      signatureHeader: sign(BODY, stale),
      secret: SECRET,
      nowSeconds: NOW,
    });
    expect(result.ok).toBe(false);
  });

  test("accepts a delivery inside the window", () => {
    const recent = NOW - MAX_TIMESTAMP_SKEW_SECONDS + 1;
    const result = verifyWebhookSignature({
      rawBody: BODY,
      signatureHeader: sign(BODY, recent),
      secret: SECRET,
      nowSeconds: NOW,
    });
    expect(result.ok).toBe(true);
  });

  test("rejects a malformed header", () => {
    for (const header of ["", "t=abc,v1=", "v1=deadbeef", "garbage"]) {
      expect(
        verifyWebhookSignature({
          rawBody: BODY,
          signatureHeader: header,
          secret: SECRET,
          nowSeconds: NOW,
        }).ok,
      ).toBe(false);
    }
  });

  test("a length mismatch does not throw", () => {
    // timingSafeEqual throws on unequal lengths; the comparison has to handle
    // that without turning a bad signature into a 500.
    const result = verifyWebhookSignature({
      rawBody: BODY,
      signatureHeader: `t=${NOW},v1=abcd`,
      secret: SECRET,
      nowSeconds: NOW,
    });
    expect(result.ok).toBe(false);
  });
});

describe("parseSignatureHeader", () => {
  test("parses the timestamped form", () => {
    expect(parseSignatureHeader("t=1700,v1=deadbeef")).toEqual({
      timestamp: 1700,
      signature: "deadbeef",
    });
  });

  test("tolerates whitespace between parts", () => {
    expect(parseSignatureHeader(" t=1700, v1=deadbeef ")).toEqual({
      timestamp: 1700,
      signature: "deadbeef",
    });
  });

  test("accepts a bare hex digest", () => {
    const parsed = parseSignatureHeader("deadbeefcafe");
    expect(parsed?.signature).toBe("deadbeefcafe");
  });

  test("returns undefined for junk", () => {
    expect(parseSignatureHeader("not a signature")).toBeUndefined();
  });
});
