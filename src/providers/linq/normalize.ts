/**
 * Linq payload to `PluginInboundEvent`.
 *
 * The one job here is to turn untrusted provider JSON into the shape the
 * gateway's admission pipeline consumes, dropping anything that must not
 * become a turn. Every drop is silent and returns `undefined`: a delivery
 * receipt is not an error.
 *
 * Nothing in this module decides whether a message is *allowed*. Trust
 * classification and the admission floor live in the gateway and stay there;
 * this module's contribution to that decision is getting `actorExternalId`
 * right and stamping the SMS/iMessage distinction so the gateway can act on
 * it.
 */

import type { LinqMessage } from "./schemas.ts";
import {
  conversationIdOf,
  createdAtOf,
  eventNameOf,
  isInboundMessage,
  isInboundMessageEvent,
  LinqMessageSchema,
  LinqWebhookEventSchema,
  messageFromWebhookEvent,
  senderHandleOf,
  textFromParts,
} from "./schemas.ts";
import { CHANNEL_ID } from "../../plugin-paths.ts";
import type { PluginInboundEvent } from "../../channel/contract.ts";
import { resolveIdentity } from "../../channel/identity.ts";
import type { WebhookDelivery } from "../types.ts";

/**
 * Chat type stamped on the event.
 *
 * Not cosmetic. SMS sender IDs are spoofable in a way iMessage identities
 * are not, so the gateway needs the distinction to classify a green bubble
 * more harshly than a blue one. RCS and an absent `service` read as `sms`,
 * the more conservative of the options: a missing signal must not buy the
 * sender the stronger identity.
 */
export function chatTypeFor(message: LinqMessage): "imessage" | "sms" {
  return message.service === "iMessage" ? "imessage" : "sms";
}

/**
 * Normalize one Linq message.
 *
 * Returns `undefined` when the message must not become a turn:
 *   - it is outbound (our own reply echoed back)
 *   - it has no attributable sender (cannot be trust-classified)
 *   - it has no text content (a receipt, or an attachment-only message,
 *     which v1 does not carry)
 *
 * `receivedAt` is supplied by the caller so the host's wall clock is the
 * source of truth, never `created_at` off the wire.
 */
export function normalizeLinqMessage(
  raw: unknown,
  receivedAt: string,
): PluginInboundEvent | undefined {
  const parsed = LinqMessageSchema.safeParse(raw);
  if (!parsed.success) {
    return undefined;
  }
  const message = parsed.data;

  if (!isInboundMessage(message)) {
    return undefined;
  }

  const identity = resolveIdentity({
    from: senderHandleOf(message),
    conversationId: conversationIdOf(message),
  });
  if (!identity) {
    return undefined;
  }

  const content = textFromParts(message);
  if (!content) {
    return undefined;
  }

  return {
    version: "v1",
    sourceChannel: CHANNEL_ID,
    receivedAt,
    message: {
      content,
      conversationExternalId: identity.conversationExternalId,
      externalMessageId: message.id,
    },
    actor: {
      actorExternalId: identity.actorExternalId,
    },
    source: {
      updateId: message.id,
      messageId: message.id,
      chatType: chatTypeFor(message),
    },
    raw: (raw ?? {}) as Record<string, unknown>,
  };
}

/**
 * Read a Linq delivery and say what it is.
 *
 * Linq has no vendor ping event, so a delivery is either an inbound
 * message or something this channel ignores (receipts, outbound echoes,
 * typing, reactions).
 */
export function classifyLinqWebhook(
  raw: unknown,
  receivedAt: string,
): WebhookDelivery {
  const parsed = LinqWebhookEventSchema.safeParse(raw);
  if (!parsed.success) {
    return { kind: "ignored", reason: "unrecognized webhook envelope" };
  }

  if (!isInboundMessageEvent(parsed.data)) {
    const name = eventNameOf(parsed.data) ?? "unnamed";
    return { kind: "ignored", reason: `${name} is not an inbound message` };
  }

  const message = messageFromWebhookEvent(parsed.data);
  const event = message ? normalizeLinqMessage(message, receivedAt) : undefined;
  return event
    ? { kind: "message", event }
    : { kind: "ignored", reason: "inbound message carried no usable turn" };
}

export { createdAtOf };
