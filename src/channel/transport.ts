/**
 * Outbound half of the channel.
 *
 * The assistant renders a reply and the host routes it here. Provider-agnostic:
 * the actual send goes through whichever `MessagingProvider` is configured.
 *
 * Two things matter more on a phone line than on most channels:
 *
 * - **Idempotency.** A retried send after a timeout delivers twice, and the
 *   recipient sees both. Every send carries a key derived from the target and
 *   the body.
 *
 * - **Plain text.** iMessage renders no markdown. Tables, code fences, and bold
 *   markers arrive as literal punctuation, so the reply is flattened first.
 */

import { createHash } from "node:crypto";

import { CHANNEL_ID } from "../plugin-paths.ts";
import type {
  PluginChannelTransport,
  PluginDeliveryResult,
  PluginReplyPayload,
} from "./contract.ts";
import type { MessagingProvider, SendTarget } from "../providers/types.ts";

/**
 * Per-message cap. SMS segments long messages and iMessage tolerates more, but
 * an assistant reply running to thousands of characters is a bad message on
 * either, and on SMS it is also expensive.
 */
const MAX_BODY_LENGTH = 1_400;

/**
 * Separator between the two parts of the idempotency input.
 *
 * Written as the escape `\u001f`, never typed inline: a raw control byte in
 * source makes git treat the whole file as binary, which hides it from diffs
 * and review entirely. `src/__tests__/source-hygiene.test.ts` enforces that.
 *
 * U+001F (unit separator) cannot occur in a phone number or a rendered message
 * body, so `("a b", "c")` and `("a", "b c")` cannot collide the way a space
 * separator would let them.
 */
const KEY_SEPARATOR = "\u001f";

export function createTransport(
  provider: MessagingProvider,
): PluginChannelTransport {
  return {
    channel: CHANNEL_ID,

    async deliver(
      conversationExternalId: string,
      payload: PluginReplyPayload,
    ): Promise<PluginDeliveryResult> {
      const body = flattenForPlainText(payload.text ?? "");
      if (!body) {
        // Nothing to say is a success, not a failure: an empty render should
        // not surface as a delivery error.
        return { ok: true };
      }

      try {
        const result = await provider.send(
          targetFor(conversationExternalId),
          body,
          { idempotencyKey: idempotencyKey(conversationExternalId, body) },
        );
        return { ok: true, externalMessageId: result.id };
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
 * the provider did not supply a conversation id, so an E.164-looking value
 * addresses `to` and anything else addresses `conversationId`.
 */
export function targetFor(conversationExternalId: string): SendTarget {
  return /^\+\d{7,15}$/.test(conversationExternalId)
    ? { to: conversationExternalId }
    : { conversationId: conversationExternalId };
}

/**
 * Stable key for a send.
 *
 * Derived from the target and the body so a retry of the same send collapses.
 * A genuinely repeated message differs by conversation state rather than by
 * this key, so the window is deliberately narrow: the same text to the same
 * target within the provider's idempotency retention is treated as one send.
 */
export function idempotencyKey(target: string, body: string): string {
  return createHash("sha256")
    .update(`${target}${KEY_SEPARATOR}${body}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Flatten markdown to something that reads correctly in a message bubble.
 *
 * Deliberately lossy. The alternative is the recipient reading raw `**` and
 * backticks, which looks broken in a way plain prose does not.
 */
export function flattenForPlainText(text: string): string {
  let out = text.trim();
  if (!out) return "";

  // Fenced code: drop the fence, keep the contents.
  out = out.replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, (_m, code) =>
    String(code).trim(),
  );
  // Inline code, bold, italic, strikethrough.
  out = out.replace(/`([^`]+)`/g, "$1");
  out = out.replace(/\*\*([^*]+)\*\*/g, "$1");
  out = out.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "$1");
  out = out.replace(/~~([^~]+)~~/g, "$1");
  // Links: keep the label, append the URL so it stays tappable.
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1 ($2)");
  // Headings and blockquote markers.
  out = out.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  out = out.replace(/^\s{0,3}>\s?/gm, "");
  // Bullets to a character that renders in a bubble.
  out = out.replace(/^\s*[-*+]\s+/gm, "• ");
  // Collapse the blank-line runs markdown leaves behind.
  out = out.replace(/\n{3,}/g, "\n\n");

  out = out.trim();
  return out.length > MAX_BODY_LENGTH
    ? `${out.slice(0, MAX_BODY_LENGTH - 1).trimEnd()}…`
    : out;
}
