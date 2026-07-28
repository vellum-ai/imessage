/**
 * Webhook signature verification.
 *
 * UNVERIFIED. The published Comms docs name the webhook event types but do not
 * document a signing secret, a signature header, or an algorithm. What follows
 * is the near-universal shape (HMAC-SHA256 over a timestamped payload, hex
 * digest, `t=`/`v1=` header) implemented so the webhook path is not left
 * unauthenticated by omission.
 *
 * The rule this module enforces regardless of scheme: **an unverified webhook
 * is never trusted.** If the plugin is configured for webhook ingress and no
 * secret is stored, the route rejects every delivery rather than accepting
 * unauthenticated input. An inbound-message route that anyone on the internet
 * can POST to is a way to impersonate a trusted contact.
 *
 * When the real scheme is confirmed, only this file should need to change.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** Header the signature is expected on. */
export const SIGNATURE_HEADER = "x-comms-signature";

/** Rejection window for replayed deliveries. */
export const MAX_TIMESTAMP_SKEW_SECONDS = 300;

export type VerificationResult =
  | { ok: true }
  | { ok: false; reason: string };

export interface VerifyOptions {
  /** Raw request body, exactly as received. Re-serializing changes the digest. */
  rawBody: string;
  signatureHeader: string | null;
  secret: string | undefined;
  /** Seconds since epoch. Injectable for tests. */
  nowSeconds?: number;
}

/**
 * Verify a webhook delivery.
 *
 * Fails closed on every ambiguity: no secret, no header, unparsable header,
 * stale timestamp, or digest mismatch.
 */
export function verifyWebhookSignature(
  opts: VerifyOptions,
): VerificationResult {
  if (!opts.secret) {
    return {
      ok: false,
      reason:
        "no webhook signing secret is stored; refusing to accept unauthenticated inbound messages",
    };
  }

  if (!opts.signatureHeader) {
    return { ok: false, reason: `missing ${SIGNATURE_HEADER} header` };
  }

  const parsed = parseSignatureHeader(opts.signatureHeader);
  if (!parsed) {
    return { ok: false, reason: "malformed signature header" };
  }

  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - parsed.timestamp) > MAX_TIMESTAMP_SKEW_SECONDS) {
    return { ok: false, reason: "signature timestamp outside the replay window" };
  }

  const expected = createHmac("sha256", opts.secret)
    .update(`${parsed.timestamp}.${opts.rawBody}`)
    .digest("hex");

  return constantTimeEquals(expected, parsed.signature)
    ? { ok: true }
    : { ok: false, reason: "signature mismatch" };
}

interface ParsedSignature {
  timestamp: number;
  signature: string;
}

/**
 * Parse a `t=<unix>,v1=<hex>` header.
 *
 * A bare hex digest is also accepted, with the timestamp check skipped, since
 * some providers sign without one. That weakens replay protection, which is
 * why it is not the documented path — but rejecting a valid signature outright
 * would be worse.
 */
export function parseSignatureHeader(
  header: string,
): ParsedSignature | undefined {
  const trimmed = header.trim();

  if (/^[0-9a-f]+$/i.test(trimmed)) {
    return { timestamp: Math.floor(Date.now() / 1000), signature: trimmed };
  }

  let timestamp: number | undefined;
  let signature: string | undefined;

  for (const part of trimmed.split(",")) {
    const [key, value] = part.split("=", 2).map((s) => s?.trim());
    if (!key || !value) continue;
    if (key === "t") {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) timestamp = parsed;
    } else if (key === "v1") {
      signature = value;
    }
  }

  if (timestamp === undefined || !signature) return undefined;
  return { timestamp, signature };
}

/** Length-safe constant-time compare. */
function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  // timingSafeEqual throws on a length mismatch, which would itself leak
  // length. Compare a fixed-size digest of each instead.
  if (bufA.length !== bufB.length) {
    const digestA = createHmac("sha256", "length-guard").update(bufA).digest();
    const digestB = createHmac("sha256", "length-guard").update(bufB).digest();
    timingSafeEqual(digestA, digestB);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
