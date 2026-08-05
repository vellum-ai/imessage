/**
 * Wire format between the poll worker and its supervisor.
 *
 * Newline-delimited JSON on the worker's stdout. Deliberately boring: the
 * supervisor has to be able to resync after a partial line, and NDJSON makes
 * "drop the unparsable line, keep going" the natural behavior.
 */

import { z } from "zod";

import type { PluginInboundEvent } from "../channel/contract.ts";
import { PROVIDER_IDS } from "../providers/types.ts";

/**
 * Config the supervisor hands the worker on startup.
 *
 * `provider` comes from `PROVIDER_IDS` rather than a list spelled out here: a
 * second copy can only ever agree with the registry or reject a provider the
 * rest of the plugin accepts, and the worker refusing to start is a quiet way
 * for that to show up.
 */
export const WorkerBootstrapSchema = z.object({
  storageDir: z.string().min(1),
  intervalMs: z.number().int().positive(),
  provider: z.enum(PROVIDER_IDS),
});
export type WorkerBootstrap = z.infer<typeof WorkerBootstrapSchema>;

export type WorkerMessage =
  | { type: "ready" }
  | { type: "event"; event: PluginInboundEvent }
  | { type: "log"; level: "debug" | "info" | "warn" | "error"; msg: string; data?: unknown }
  | { type: "fatal"; error: string };

/**
 * Parse one line from the worker.
 *
 * Tolerant on purpose: a malformed line is dropped rather than killing the
 * supervisor. The worker is a subprocess whose stdout can carry a stray write
 * from a dependency, and one such line must not take the channel down.
 */
export function parseWorkerLine(line: string): WorkerMessage | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as WorkerMessage;
    if (typeof parsed !== "object" || parsed === null) return undefined;
    if (typeof (parsed as { type?: unknown }).type !== "string") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/** Serialize one message for stdout. */
export function encodeWorkerMessage(message: WorkerMessage): string {
  return `${JSON.stringify(message)}\n`;
}
