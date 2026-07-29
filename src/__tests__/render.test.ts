import { describe, expect, test } from "bun:test";

import {
  chunkForDelivery,
  flattenForPlainText,
  idempotencyKey,
  MAX_CHUNK_LENGTH,
  MAX_CHUNKS,
} from "../channel/render.ts";

describe("chunkForDelivery", () => {
  test("a short reply is one chunk", () => {
    expect(chunkForDelivery("hello")).toEqual(["hello"]);
  });

  test("empty input is no chunks, not an empty message", () => {
    expect(chunkForDelivery("")).toEqual([]);
    expect(chunkForDelivery("   ")).toEqual([]);
  });

  test("flattens before measuring", () => {
    // Markdown that flattens under the limit must not be split on its
    // pre-flattening length.
    expect(chunkForDelivery("**hello**")).toEqual(["hello"]);
  });

  test("splits a long reply instead of truncating it", () => {
    // The behavior this replaced cut at the limit and appended an ellipsis,
    // silently dropping the rest.
    const text = "Sentence number one. ".repeat(200);
    const chunks = chunkForDelivery(text);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(MAX_CHUNK_LENGTH);
    }
  });

  test("loses no words when it splits", () => {
    const text = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
    const rejoined = chunkForDelivery(text).join(" ");

    expect(rejoined).toContain("word0");
    expect(rejoined).toContain("word399");
    expect(rejoined.split(/\s+/).length).toBe(400);
  });

  test("prefers a paragraph boundary", () => {
    const first = "a".repeat(600);
    const second = "b".repeat(600);
    const third = "c".repeat(600);
    const chunks = chunkForDelivery(`${first}\n\n${second}\n\n${third}`);

    // The first cut should land on the blank line, not mid-run.
    expect(chunks[0]).toBe(`${first}\n\n${second}`.trim());
  });

  test("falls back to a word boundary", () => {
    const text = `${"word ".repeat(400)}end`;
    const chunks = chunkForDelivery(text);

    for (const chunk of chunks) {
      expect(chunk.startsWith(" ")).toBe(false);
      expect(chunk.endsWith(" ")).toBe(false);
    }
  });

  test("hard-cuts a single unbroken run", () => {
    // A 3000-character URL or hash has no boundary to break on.
    const chunks = chunkForDelivery("x".repeat(3000));

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.length).toBe(MAX_CHUNK_LENGTH);
  });

  test("says so when it runs out of chunks", () => {
    // A reply that just stops is indistinguishable from a delivery failure.
    const chunks = chunkForDelivery("word ".repeat(20_000));

    expect(chunks.length).toBe(MAX_CHUNKS);
    expect(chunks[chunks.length - 1]).toContain("[message truncated]");
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(MAX_CHUNK_LENGTH);
    }
  });

  test("does not add a truncation notice when everything fits", () => {
    const chunks = chunkForDelivery("Sentence number one. ".repeat(200));
    expect(chunks.join(" ")).not.toContain("[message truncated]");
  });
});

describe("idempotencyKey", () => {
  test("is stable for the same inputs", () => {
    expect(idempotencyKey("+1555", "hi", 0)).toBe(
      idempotencyKey("+1555", "hi", 0),
    );
  });

  test("differs across targets and bodies", () => {
    expect(idempotencyKey("+1555", "hi")).not.toBe(
      idempotencyKey("+1556", "hi"),
    );
    expect(idempotencyKey("+1555", "hi")).not.toBe(
      idempotencyKey("+1555", "ho"),
    );
  });

  test("distinguishes identical chunks of one reply", () => {
    // A long reply can legitimately repeat itself. Keying on the body alone
    // would have the provider collapse the second chunk and drop it.
    expect(idempotencyKey("+1555", "same text", 0)).not.toBe(
      idempotencyKey("+1555", "same text", 1),
    );
  });

  test("the separator prevents a boundary collision", () => {
    // With a space separator, ("a b", "c") and ("a", "b c") hash the same
    // input, collapsing two distinct sends into one.
    expect(idempotencyKey("a b", "c")).not.toBe(idempotencyKey("a", "b c"));
  });
});

describe("flattenForPlainText", () => {
  test("no longer truncates", () => {
    // Length handling moved to chunkForDelivery; flattening must pass long
    // text through untouched or the chunker has nothing to split.
    const long = "x".repeat(3000);
    expect(flattenForPlainText(long).length).toBe(3000);
  });
});
