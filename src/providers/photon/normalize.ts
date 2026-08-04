/**
 * Photon payloads to `PluginInboundEvent`.
 *
 * Two entry points because Photon has two inbound shapes — a webhook delivery
 * and a message read back off the message plane — and they share nothing but
 * the destination type. Both drop anything that must not become a turn, and
 * every drop is silent: a tapback is not an error.
 *
 * Nothing here decides whether a message is *allowed*. Trust classification
 * and the admission floor live in the gateway; this module's contribution to
 * that decision is getting `actorExternalId` right and stamping the chat type.
 */

import type { PhotonMessage, WebhookEvent, WebhookMessage } from "./schemas.ts";
import {
  chatGuidOf,
  isInboundMessageEvent,
  PhotonMessageSchema,
  WebhookEventSchema,
} from "./schemas.ts";
import { CHANNEL_ID } from "../../plugin-paths.ts";
import type { PluginInboundEvent } from "../../channel/contract.ts";
import { resolveIdentity } from "../../channel/identity.ts";

/**
 * Chat type stamped on the event.
 *
 * Photon reports the platform per message (`iMessage`, `SMS`, `RCS`). Same
 * rule as the Comms adapter: anything that is not explicitly iMessage reads as
 * `sms`, the more conservative of the two. SMS sender ids are spoofable and
 * iMessage identities are not, so a missing or unrecognized signal must not
 * buy the sender the stronger identity.
 */
export function chatTypeFor(platform: string | undefined): "imessage" | "sms" {
  return platform?.toLowerCase() === "imessage" ? "imessage" : "sms";
}

/**
 * Normalize one message read off the message plane (the poll path).
 *
 * Returns `undefined` when the message must not become a turn:
 *   - it is ours (`isFromMe`), or the assistant answers itself
 *   - it is a tapback, a system message, or a service message
 *   - it has no attributable sender, so it cannot be trust-classified
 *   - it has no text, which is a receipt or an attachment-only message
 */
export function normalizePhotonMessage(
  raw: unknown,
  receivedAt: string,
): PluginInboundEvent | undefined {
  const parsed = PhotonMessageSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const message = parsed.data;

  if (message.isFromMe) return undefined;
  if (message.reactionTargetGuid) return undefined;
  if (message.isSystemMessage || message.isServiceMessage) return undefined;

  const identity = resolveIdentity({
    from: message.sender?.address,
    conversationId: chatGuidOf(message),
  });
  if (!identity) return undefined;

  const content = message.content?.text?.trim();
  if (!content) return undefined;

  return {
    version: "v1",
    sourceChannel: CHANNEL_ID,
    receivedAt,
    message: {
      content,
      conversationExternalId: identity.conversationExternalId,
      externalMessageId: message.guid,
    },
    actor: { actorExternalId: identity.actorExternalId },
    source: {
      updateId: message.guid,
      messageId: message.guid,
      chatType: chatTypeFor(serviceNameOf(message)),
    },
    raw: (raw ?? {}) as Record<string, unknown>,
  };
}

/**
 * Normalize a `messages` webhook delivery.
 *
 * The webhook carries its own flatter shape — `message.sender.id` rather than
 * `sender.address`, `space.id` rather than `chatGuids` — so it is mapped here
 * rather than coerced into the message-plane schema. The space id is exactly
 * the chat guid the message plane wants back for a reply (`any;-;+1555…`),
 * which is what lets a reply skip chat resolution entirely.
 */
export function normalizeWebhookEvent(
  raw: unknown,
  receivedAt: string,
): PluginInboundEvent | undefined {
  const parsed = WebhookEventSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const event: WebhookEvent = parsed.data;
  if (!isInboundMessageEvent(event)) return undefined;

  const message: WebhookMessage | undefined = event.message;
  if (!message) return undefined;

  const space = message.space ?? event.space;
  const identity = resolveIdentity({
    from: message.sender?.id,
    conversationId: space?.id,
  });
  if (!identity) return undefined;

  const content = message.content?.text?.trim();
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
    actor: { actorExternalId: identity.actorExternalId },
    source: {
      updateId: message.id,
      messageId: message.id,
      chatType: chatTypeFor(message.platform ?? space?.platform),
    },
    raw: (raw ?? {}) as Record<string, unknown>,
  };
}

/**
 * The service name off a message-plane payload.
 *
 * Protobuf-JSON may render the enum as its name or its ordinal, so both are
 * accepted; `1` is `CHAT_SERVICE_TYPE_IMESSAGE`.
 */
function serviceNameOf(message: PhotonMessage): string | undefined {
  const service = message.sender?.service;
  if (typeof service === "string") return service;
  if (service === 1) return "imessage";
  return undefined;
}
