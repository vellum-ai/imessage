/**
 * Poll cursor — durable, so a restart neither replays the backlog nor skips
 * what arrived while the daemon was down.
 *
 * The cursor is a `since` timestamp plus the ids seen at that timestamp. The
 * id set is what makes the timestamp safe to use: `since` bounds are
 * whole-second in practice and the docs do not say whether the bound is
 * inclusive. Inclusive plus no id set means every poll redelivers the last
 * message forever; exclusive plus no id set means a second message sharing
 * that timestamp is lost. Carrying the ids makes the poll correct either way.
 *
 * Lives in `pluginStorageDir` per the plugin self-containment rule: plugin
 * state belongs to the plugin, never to the assistant's global persistence.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { z } from "zod";

const CURSOR_FILENAME = "poll-cursor.json";

/**
 * Cap on retained boundary ids. Only ids sharing the cursor timestamp matter,
 * so this is generous; the bound just stops a pathological burst from growing
 * the file without limit.
 */
const MAX_SEEN_IDS = 500;

const CursorSchema = z.object({
  /** ISO-8601 bound for the next poll. */
  since: z.string().optional(),
  /** Message ids already delivered at or after `since`. */
  seenIds: z.array(z.string()).default([]),
});

export type Cursor = z.infer<typeof CursorSchema>;

export const EMPTY_CURSOR: Cursor = { since: undefined, seenIds: [] };

export function cursorPath(storageDir: string): string {
  return join(storageDir, CURSOR_FILENAME);
}

/**
 * Read the cursor, or the empty cursor when absent or unreadable.
 *
 * Fail-open by design: a corrupt cursor should degrade to "poll from now"
 * rather than block the channel from starting. `startFresh` handles the
 * first-run case, so an unreadable cursor does not replay history either.
 */
export function readCursor(storageDir: string): Cursor {
  const path = cursorPath(storageDir);
  if (!existsSync(path)) return EMPTY_CURSOR;
  try {
    const parsed = CursorSchema.safeParse(
      JSON.parse(readFileSync(path, "utf8")),
    );
    return parsed.success ? parsed.data : EMPTY_CURSOR;
  } catch {
    return EMPTY_CURSOR;
  }
}

/**
 * Persist the cursor.
 *
 * Written to a temp file and renamed so a crash mid-write cannot leave a
 * truncated cursor that reads back as "poll from the beginning".
 */
export function writeCursor(storageDir: string, cursor: Cursor): void {
  const path = cursorPath(storageDir);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(cursor, null, 2), "utf8");
  renameSync(tmp, path);
}

/**
 * Advance the cursor past a batch.
 *
 * `seenIds` is reset whenever the timestamp moves forward, since ids at an
 * older timestamp can no longer be returned by a poll bounded at the newer
 * one. Ids at the same timestamp accumulate, which is exactly the boundary
 * case they exist for.
 */
export function advanceCursor(
  cursor: Cursor,
  batch: readonly { id: string; createdAt?: string }[],
): Cursor {
  if (batch.length === 0) return cursor;

  let since = cursor.since;
  for (const item of batch) {
    if (item.createdAt && (!since || item.createdAt > since)) {
      since = item.createdAt;
    }
  }

  // No usable timestamps: hold the bound and just remember the ids, so the
  // next poll still filters the duplicates out.
  if (!since) {
    return {
      since: cursor.since,
      seenIds: capIds([...cursor.seenIds, ...batch.map((b) => b.id)]),
    };
  }

  const movedForward = since !== cursor.since;
  const carried = movedForward ? [] : cursor.seenIds;
  const atBoundary = batch
    .filter((item) => item.createdAt === since || !item.createdAt)
    .map((item) => item.id);

  return { since, seenIds: capIds([...carried, ...atBoundary]) };
}

/** Whether a message has already been delivered under this cursor. */
export function isSeen(cursor: Cursor, id: string): boolean {
  return cursor.seenIds.includes(id);
}

function capIds(ids: string[]): string[] {
  const unique = [...new Set(ids)];
  return unique.length > MAX_SEEN_IDS
    ? unique.slice(unique.length - MAX_SEEN_IDS)
    : unique;
}
