/**
 * Outbound half of the channel.
 *
 * The assistant renders a reply and the host routes it here. Provider-agnostic:
 * the actual send goes through whichever `MessagingProvider` is configured, and
 * the rendering rules live in `render.ts` so the `imessage` skill's send script
 * applies exactly the same ones from its own process.
 *
 * A long reply becomes several messages rather than one truncated one. Each
 * chunk carries its own idempotency key derived from its own body, so a retry
 * collapses per chunk and chunk 2 is never mistaken for a retry of chunk 1.
 */

import type {
  PluginChannelTransport,
  PluginDeliveryResult,
  PluginReplyPayload,
} from "./contract.ts";
import { chunkForDelivery, idempotencyKey } from "./render.ts";
import { CHANNEL_ID } from "../plugin-paths.ts";
import type { MessagingProvider, SendTarget } from "../providers/types.ts";

export function createTransport(
  provider: MessagingProvider,
): PluginChannelTransport {
  return {
    channel: CHANNEL_ID,

    async deliver(
      conversationExternalId: string,
      payload: PluginReplyPayload,
    ): Promise<PluginDeliveryResult> {
      const chunks = chunkForDelivery(payload.text ?? "");
      if (chunks.length === 0) {
        // Nothing to say is a success, not a failure: an empty render should
        // not surface as a delivery error.
        return { ok: true };
      }

      const target = targetFor(conversationExternalId);
      let lastId: string | undefined;

      for (const [index, chunk] of chunks.entries()) {
        try {
          const result = await provider.send(target, chunk, {
            idempotencyKey: idempotencyKey(
              conversationExternalId,
              chunk,
              index,
            ),
          });
          lastId = result.id;
        } catch (err) {
          // Report the failure rather than continuing: the recipient has
          // already received the earlier chunks, and pushing more after a
          // failure would deliver the reply out of order.
          return {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }

      return { ok: true, externalMessageId: lastId };
    },

    async sendTyping(
      conversationExternalId: string,
    ): Promise<PluginDeliveryResult> {
      if (!provider.setTyping) {
        return { ok: true };
      }
      try {
        await provider.setTyping(targetFor(conversationExternalId), true);
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

/**
 * Route by the shape of the conversation id.
 *
 * The normalizer uses the normalized handle as the conversation address when
 * the provider did not supply a conversation id. A phone or Apple ID is a
 * recipient (`to`). A vendor chat id is a conversation (`conversationId`).
 */
export function targetFor(conversationExternalId: string): SendTarget {
  if (
    /^\+\d{7,15}$/.test(conversationExternalId) ||
    conversationExternalId.includes("@")
  ) {
    return { to: conversationExternalId };
  }
  return { conversationId: conversationExternalId };
}

export { chunkForDelivery, flattenForPlainText, idempotencyKey } from "./render.ts";
