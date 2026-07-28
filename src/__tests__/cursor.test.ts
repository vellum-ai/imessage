import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  advanceCursor,
  cursorPath,
  EMPTY_CURSOR,
  isSeen,
  readCursor,
  writeCursor,
} from "../cursor.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "imessage-cursor-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readCursor / writeCursor", () => {
  test("round-trips", () => {
    const cursor = { since: "2026-07-28T12:00:00.000Z", seenIds: ["a", "b"] };
    writeCursor(dir, cursor);
    expect(readCursor(dir)).toEqual(cursor);
  });

  test("an absent cursor reads as empty", () => {
    expect(readCursor(dir)).toEqual(EMPTY_CURSOR);
  });

  test("a corrupt cursor degrades instead of throwing", () => {
    // Fail open: a bad cursor must not stop the channel from starting.
    writeFileSync(cursorPath(dir), "{ not json", "utf8");
    expect(readCursor(dir)).toEqual(EMPTY_CURSOR);
  });

  test("a schema-invalid cursor degrades", () => {
    writeFileSync(cursorPath(dir), JSON.stringify({ since: 42 }), "utf8");
    expect(readCursor(dir)).toEqual(EMPTY_CURSOR);
  });
});

describe("advanceCursor", () => {
  test("an empty batch leaves the cursor alone", () => {
    const cursor = { since: "2026-07-28T12:00:00.000Z", seenIds: ["a"] };
    expect(advanceCursor(cursor, [])).toEqual(cursor);
  });

  test("moves to the newest timestamp in the batch", () => {
    const next = advanceCursor(EMPTY_CURSOR, [
      { id: "a", createdAt: "2026-07-28T12:00:00.000Z" },
      { id: "b", createdAt: "2026-07-28T12:00:05.000Z" },
    ]);
    expect(next.since).toBe("2026-07-28T12:00:05.000Z");
  });

  test("retains only the ids sharing the new boundary timestamp", () => {
    // Ids at an older timestamp can no longer come back from a poll bounded at
    // the newer one, so carrying them would grow the file for nothing.
    const next = advanceCursor(EMPTY_CURSOR, [
      { id: "old", createdAt: "2026-07-28T12:00:00.000Z" },
      { id: "new1", createdAt: "2026-07-28T12:00:05.000Z" },
      { id: "new2", createdAt: "2026-07-28T12:00:05.000Z" },
    ]);
    expect(next.seenIds.sort()).toEqual(["new1", "new2"]);
  });

  test("accumulates ids when the timestamp does not move", () => {
    // The boundary case the id set exists for: two messages sharing a second,
    // arriving across two polls.
    const first = advanceCursor(EMPTY_CURSOR, [
      { id: "a", createdAt: "2026-07-28T12:00:05.000Z" },
    ]);
    const second = advanceCursor(first, [
      { id: "b", createdAt: "2026-07-28T12:00:05.000Z" },
    ]);
    expect(second.since).toBe("2026-07-28T12:00:05.000Z");
    expect(second.seenIds.sort()).toEqual(["a", "b"]);
  });

  test("holds the bound and remembers ids when timestamps are missing", () => {
    const cursor = { since: "2026-07-28T12:00:00.000Z", seenIds: [] };
    const next = advanceCursor(cursor, [{ id: "a" }]);
    expect(next.since).toBe("2026-07-28T12:00:00.000Z");
    expect(next.seenIds).toEqual(["a"]);
  });

  test("does not move backwards", () => {
    const cursor = { since: "2026-07-28T12:00:10.000Z", seenIds: [] };
    const next = advanceCursor(cursor, [
      { id: "a", createdAt: "2026-07-28T12:00:01.000Z" },
    ]);
    expect(next.since).toBe("2026-07-28T12:00:10.000Z");
  });

  test("caps the retained id set", () => {
    const batch = Array.from({ length: 700 }, (_, i) => ({
      id: `msg_${i}`,
      createdAt: "2026-07-28T12:00:05.000Z",
    }));
    expect(advanceCursor(EMPTY_CURSOR, batch).seenIds.length).toBe(500);
  });

  test("deduplicates ids", () => {
    const next = advanceCursor(EMPTY_CURSOR, [
      { id: "a", createdAt: "2026-07-28T12:00:05.000Z" },
      { id: "a", createdAt: "2026-07-28T12:00:05.000Z" },
    ]);
    expect(next.seenIds).toEqual(["a"]);
  });
});

describe("isSeen", () => {
  test("reports membership", () => {
    const cursor = { since: undefined, seenIds: ["a"] };
    expect(isSeen(cursor, "a")).toBe(true);
    expect(isSeen(cursor, "b")).toBe(false);
  });
});
