/**
 * Outbound send for the `imessage` skill's scripts.
 *
 * This runs as a standalone bun process and still uses the plugin's own
 * provider adapters. That works because `@vellumai/plugin-api` resolves to the
 * workspace shim the daemon materializes, which prefers the namespace a host
 * parked on `globalThis` and **falls back to importing the plugin-api source
 * directly when no host did** — credentials are one of the surfaces that
 * fallback exists for. The plugin installer also strips the `plugin-api` peer
 * during install precisely so a registry copy cannot shadow that shim.
 *
 * So nothing here is provider-specific: which line a message goes out over is
 * `resolveProvider`'s answer, the same one the channel transport gets, and
 * teaching this script a new provider is not a thing anyone has to do.
 * Everything below is the part a *script* owns — reading the configured
 * provider, normalizing the recipient, and reporting partial delivery.
 */

import { readConfigView } from "../../../src/app-settings.ts";
import { normalizeHandle } from "../../../src/channel/identity.ts";
import {
  chunkForDelivery,
  idempotencyKey,
} from "../../../src/channel/render.ts";
import { pluginConfigPath } from "../../../src/plugin-paths.ts";
import { resolveProvider } from "../../../src/providers/index.ts";
import type { ResolveProviderOptions } from "../../../src/providers/index.ts";

export interface SentChunk {
  id: string;
  body: string;
}

export interface SendOptions {
  to: string;
  body: string;
}

/**
 * Normalize a recipient, or throw with what is wrong.
 *
 * Delegates to the channel's own normalizer so a handle means the same thing
 * to a skill send as it does to an inbound turn — two normalizers is how one
 * person becomes two contacts. The throw is this layer's contribution: a
 * script has someone waiting on an answer, so "not a recipient" has to say
 * what to type instead.
 */
export function normalizeRecipient(raw: string): string {
  const normalized = normalizeHandle(raw);
  if (!normalized) {
    throw new Error(
      `"${raw}" is not a recipient this channel can address. ` +
        "Use E.164, e.g. +15551234567.",
    );
  }
  return normalized;
}

/**
 * Send a message, splitting it across chunks when it is long.
 *
 * Stops at the first failure rather than continuing: the recipient already has
 * the earlier chunks, and pushing more after a failure delivers the reply out
 * of order.
 */
export async function sendMessage(
  opts: SendOptions,
  /**
   * Test seam, never passed by the CLI. Photon's message plane opens a gRPC
   * channel on construction, so a test of this function would otherwise dial
   * the network.
   */
  deps: Pick<ResolveProviderOptions, "photonMessageClient"> = {},
): Promise<SentChunk[]> {
  const provider = resolveProvider({
    config: readConfigView(pluginConfigPath()),
    ...deps,
  });

  const to = normalizeRecipient(opts.to);
  const chunks = chunkForDelivery(opts.body);
  if (chunks.length === 0) {
    throw new Error("Message body is empty after formatting.");
  }

  const sent: SentChunk[] = [];

  for (const [index, chunk] of chunks.entries()) {
    try {
      const result = await provider.send({ to }, chunk, {
        idempotencyKey: idempotencyKey(to, chunk, index),
      });
      sent.push({ id: result.id ?? "", body: chunk });
    } catch (err) {
      if (sent.length > 0) {
        // Partial delivery is the dangerous case to hide: the recipient has
        // part of the reply and the assistant needs to know how much.
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Sent ${sent.length} of ${chunks.length} messages, then failed: ${reason}`,
        );
      }
      throw err;
    }
  }

  return sent;
}
