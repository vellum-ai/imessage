/**
 * Comms payload to `PluginInboundEvent`.
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

import type { CommsMessage } from "./schemas.ts";
import {
  CommsMessageSchema,
  conversationIdOf,
  isInboundMessageEvent,
  isPingEvent,
  messageFromWebhookEvent,
  WebhookEventSchema,
} from "./schemas.ts";
import { CHANNEL_ID } from "../../plugin-paths.ts";
import type { PluginInboundEvent } from "../../channel/contract.ts";
import { resolveIdentity } from "../../channel/identity.ts";
import type { WebhookDelivery } from "../types.ts";

/**
 * Chat type stamped on the event.
 *
 * Not cosmetic. SMS sender IDs are spoofable in a way iMessage identities are
 * not, so the gateway needs the distinction to classify a green bubble more
 * harshly than a blue one. An absent `channel` field reads as `sms`, the more
 * conservative of the two — a missing signal must not buy the sender the
 * stronger identity.
 */
export function chatTypeFor(message: CommsMessage): "imessage" | "sms" {
  return message.channel === "imessage" ? "imessage" : "sms";
}

/**
 * Normalize one Comms message.
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
export function normalizeCommsMessage(
  raw: unknown,
  receivedAt: string,
): PluginInboundEvent | undefined {
  const parsed = CommsMessageSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const message = parsed.data;

  if (message.direction !== "inbound") return undefined;

  const identity = resolveIdentity({
    from: message.from,
    conversationId: conversationIdOf(message),
  });
  if (!identity) return undefined;

  const content = message.body?.trim();
  if (!content) return undefined;

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
    // Verbatim, per the gateway's ingress rule: only the parsed working copy
    // is schema-shaped.
    raw: (raw ?? {}) as Record<string, unknown>,
  };
}

/**
 * Normalize a webhook delivery.
 *
 * Accepts both envelope shapes Comms might use and drops anything that is not
 * an inbound message event before unwrapping.
 */
export function normalizeWebhookEvent(
  raw: unknown,
  receivedAt: string,
): PluginInboundEvent | undefined {
  const parsed = WebhookEventSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  if (!isInboundMessageEvent(parsed.data)) return undefined;

  const message = messageFromWebhookEvent(parsed.data);
  if (!message) return undefined;

  return normalizeCommsMessage(message, receivedAt);
}

/**
 * Read a Comms delivery and say what it is.
 *
 * The order matters. A ping is checked first because it carries no message at
 * all, so every later branch would report it as something missing rather than
 * as the successful delivery test it is.
 */
export function classifyCommsWebhook(
  raw: unknown,
  receivedAt: string,
): WebhookDelivery {
  const parsed = WebhookEventSchema.safeParse(raw);
  if (!parsed.success) {
    return { kind: "ignored", reason: "unrecognized webhook envelope" };
  }

  if (isPingEvent(parsed.data)) {
    return { kind: "probe", label: parsed.data.event ?? parsed.data.type ?? "ping" };
  }

  if (!isInboundMessageEvent(parsed.data)) {
    const name = parsed.data.event ?? parsed.data.type ?? "unnamed";
    return { kind: "ignored", reason: `${name} is not an inbound message` };
  }

  const message = messageFromWebhookEvent(parsed.data);
  const event = message ? normalizeCommsMessage(message, receivedAt) : undefined;
  return event
    ? { kind: "message", event }
    : { kind: "ignored", reason: "inbound message carried no usable turn" };
}
