import { describe, expect, test } from "bun:test";

import {
  describeApiFailure,
  errorBodyDetail,
} from "../providers/error-detail.ts";

describe("errorBodyDetail", () => {
  test("pulls the readable half out of a JSON envelope", () => {
    expect(errorBodyDetail('{"message":"unsupported content type"}')).toBe(
      "unsupported content type",
    );
    expect(errorBodyDetail('{"error":"chat guid not found"}')).toBe(
      "chat guid not found",
    );
  });

  test("reaches one level into a nested error object", () => {
    // `{"error":{"message":"..."}}` is common enough that reporting the
    // punctuation around the sentence would be a wasted line.
    expect(
      errorBodyDetail('{"error":{"code":13,"message":"scope missing"}}'),
    ).toBe("scope missing");
  });

  test("falls back to the raw text when the body is not JSON", () => {
    expect(errorBodyDetail("<html><body>415</body></html>")).toBe(
      "<html><body>415</body></html>",
    );
  });

  test("falls back to the raw text when JSON carries no message field", () => {
    expect(errorBodyDetail('{"code":415}')).toBe('{"code":415}');
  });

  test("collapses to one line", () => {
    // The result goes into log lines and CLI stderr, where an embedded
    // newline splits one failure into what reads as several.
    expect(errorBodyDetail("first line\n  second line\n")).toBe(
      "first line second line",
    );
  });

  test("truncates a long body rather than pasting a page into every log", () => {
    const detail = errorBodyDetail("x".repeat(1000));
    expect(detail).toHaveLength(301);
    expect(detail?.endsWith("…")).toBe(true);
  });

  test("says nothing when there is nothing to say", () => {
    expect(errorBodyDetail(undefined)).toBeUndefined();
    expect(errorBodyDetail("")).toBeUndefined();
    expect(errorBodyDetail("   \n  ")).toBeUndefined();
  });
});

describe("describeApiFailure", () => {
  test("keeps the status first and appends what the provider said", () => {
    // Status first so every failure has the same shape and greps still work;
    // the detail is what makes it fixable rather than merely classifiable.
    expect(
      describeApiFailure(
        "Photon POST /v1/chats",
        415,
        '{"message":"unsupported content type"}',
      ),
    ).toBe("Photon POST /v1/chats failed: 415 — unsupported content type");
  });

  test("degrades to the status alone when the body is empty", () => {
    expect(describeApiFailure("Photon POST /v1/chats", 415, undefined)).toBe(
      "Photon POST /v1/chats failed: 415",
    );
  });
});
