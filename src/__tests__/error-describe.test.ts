/**
 * `describeError` — the difference between a diagnosable log line and one that
 * sends the reader to check something that was already correct.
 *
 * The case that motivated it: webhook registration failed seconds after a
 * restart, and the recorded reason was the outermost frame of an error whose
 * only informative frame was two levels down.
 */

import { describe, expect, test } from "bun:test";

import { describeError } from "../providers/error-detail.ts";

describe("describeError", () => {
  test("follows the cause chain `fetch` hides the real reason behind", () => {
    // `fetch` rejects with a bare `TypeError: fetch failed` and puts the
    // answer on `.cause`. Reading `.message` reports the one frame that says
    // nothing.
    const cause = new Error("connect ECONNREFUSED 10.0.0.1:443");
    const err = new TypeError("fetch failed", { cause });

    const described = describeError(err);

    expect(described).toContain("fetch failed");
    expect(described).toContain("ECONNREFUSED");
  });

  test("names the type of the outermost error", () => {
    // A `TypeError` and an `Error` carrying the same text are different
    // diagnoses, and the name is one word.
    expect(describeError(new TypeError("fetch failed"))).toStartWith(
      "TypeError:",
    );
    expect(describeError(new Error("plain"))).toBe("plain");
  });

  test("names a status the message does not already carry", () => {
    const err = Object.assign(new Error("refused"), { status: 403 });
    expect(describeError(err)).toContain("403");
  });

  test("does not repeat a status the message already leads with", () => {
    // Both API error types build their message from `describeApiFailure`,
    // which puts the status first. Saying it twice is noise.
    const err = Object.assign(new Error("Comms API GET /webhooks failed: 403"), {
      status: 403,
    });
    expect(describeError(err).match(/403/g)).toHaveLength(1);
  });

  test("stays one bounded line", () => {
    // It goes into log lines and into the settings app. An unbounded chain
    // from a third-party library would bury the failure it explains.
    const err = new Error(`${"x".repeat(500)}\nsecond line`);
    const described = describeError(err);

    expect(described.length).toBeLessThanOrEqual(301);
    expect(described).not.toContain("\n");
  });

  test("describes something that is not an Error at all", () => {
    expect(describeError("just a string")).toBe("just a string");
    expect(describeError(undefined)).toBe("");
  });

  test("stops rather than walking a cause chain forever", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as { cause?: unknown }).cause = b;

    expect(() => describeError(b)).not.toThrow();
  });
});
