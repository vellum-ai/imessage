/**
 * External conversation to assistant conversation binding.
 *
 * A phone thread is continuous — the person expects the assistant to remember
 * what they said an hour ago. `runConversationTurn` creates a new conversation
 * when given no id, so without a durable binding every inbound message would
 * start a fresh one and the assistant would have amnesia between texts.
 *
 * Lives in `pluginStorageDir` per the plugin self-containment rule: plugin
 * state belongs to the plugin, never to the assistant's global persistence.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { z } from "zod";

const FILENAME = "conversation-map.json";

const MapSchema = z.record(z.string(), z.string());
export type ConversationMap = z.infer<typeof MapSchema>;

export function conversationMapPath(storageDir: string): string {
  return join(storageDir, FILENAME);
}

/**
 * Read the binding table.
 *
 * A corrupt or absent file reads as empty. That means new conversations rather
 * than a crash — losing thread continuity is bad, but refusing to answer at all
 * is worse.
 */
export function readConversationMap(storageDir: string): ConversationMap {
  const path = conversationMapPath(storageDir);
  if (!existsSync(path)) return {};
  try {
    const parsed = MapSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/**
 * Look up the assistant conversation bound to an external thread.
 */
export function getBoundConversation(
  storageDir: string,
  conversationExternalId: string,
): string | undefined {
  return readConversationMap(storageDir)[conversationExternalId];
}

/**
 * Bind an external thread to an assistant conversation.
 *
 * Written to a temp file and renamed so a crash mid-write cannot leave a
 * truncated map that reads back as empty and orphans every thread at once.
 *
 * Re-reads before writing rather than holding the map in memory: the poll
 * worker and the webhook route are separate processes, and a cached copy in
 * one would clobber the other's bindings.
 */
export function bindConversation(
  storageDir: string,
  conversationExternalId: string,
  conversationId: string,
): void {
  const current = readConversationMap(storageDir);
  current[conversationExternalId] = conversationId;

  const path = conversationMapPath(storageDir);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(current, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}
