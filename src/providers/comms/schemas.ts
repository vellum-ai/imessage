/**
 * Tolerant Zod schemas for everything Comms sends us.
 *
 * Comms payloads are untrusted external input, so these follow the gateway's
 * ingress rule: validate each field's type but `.optional().catch(undefined)`
 * it, so a malformed field collapses to `undefined` rather than rejecting the
 * whole payload. Only the fields the normalizer actually keys on for identity
 * and dedup are required.
 *
 * ## Fields the published docs pin down
 *
 * `docs.osis.co/messages-api/send-message` and `.../list-messages` document a
 * message as `{ id, body, direction }` and say the full object "may include
 * additional fields like channel, contact/handle identifiers, timestamps, and
 * conversation references" without naming them.
 *
 * Everything past `id` / `body` / `direction` below is therefore an informed
 * guess at the wire names, marked UNVERIFIED. They are all optional, so a
 * wrong guess degrades (the field reads as absent) rather than dropping the
 * message. `pickFirstString` accepts several plausible spellings for the
 * load-bearing ones so a naming mismatch does not silently strand every
 * inbound message.
 *
 * Confirm against a real payload before this ships. `logUnknownMessageKeys`
 * exists to make that cheap: it reports wire keys the schema does not model.
 */

import { z } from "zod";

/** Optional string that collapses to `undefined` when malformed. */
const softString = z.string().optional().catch(undefined);

/**
 * Delivery channel a message used. Comms picks `imessage` when the handle
 * supports it and falls back to `sms`.
 *
 * The distinction is load-bearing for trust, not cosmetic: SMS sender IDs are
 * trivially spoofable, iMessage identities are not. `normalize.ts` carries it
 * through so admission can treat a green bubble more harshly than a blue one.
 */
export const CommsChannelSchema = z.enum(["sms", "imessage"]);
export type CommsChannel = z.infer<typeof CommsChannelSchema>;

export const CommsDirectionSchema = z.enum(["inbound", "outbound"]);
export type CommsDirection = z.infer<typeof CommsDirectionSchema>;

/**
 * A message as Comms reports it.
 *
 * Required: `id` (dedup key) and `direction` (an outbound echo must never be
 * replayed into the assistant as user input). Everything else is optional —
 * an attachment-only message legitimately has no `body`.
 */
export const CommsMessageSchema = z.looseObject({
  id: z.string().min(1),
  direction: CommsDirectionSchema,
  body: softString,

  // UNVERIFIED wire names below.
  channel: CommsChannelSchema.optional().catch(undefined),
  conversation_id: softString,
  conversationId: softString,
  /** Sender handle in E.164. */
  from: softString,
  /** Recipient handle in E.164 — the line that received it, for inbound. */
  to: softString,
  contact_id: softString,
  contactId: softString,
  created_at: softString,
  createdAt: softString,
  timestamp: softString,
});
export type CommsMessage = z.infer<typeof CommsMessageSchema>;

/** `GET /api/v1/comms/messages` */
export const ListMessagesResponseSchema = z.looseObject({
  messages: z.array(CommsMessageSchema).catch([]),
  next_cursor: softString,
  nextCursor: softString,
});
export type ListMessagesResponse = z.infer<typeof ListMessagesResponseSchema>;

/** `POST /api/v1/comms/messages` */
export const SendMessageResponseSchema = z.looseObject({
  message: CommsMessageSchema.optional().catch(undefined),
  duplicate: z.boolean().optional().catch(undefined),
});
export type SendMessageResponse = z.infer<typeof SendMessageResponseSchema>;

/**
 * A webhook delivery. Docs name the event types (`message.received`,
 * `message.sent`) but not the envelope, so both the common shapes are
 * accepted: a wrapped `{ event, data: { message } }` and a flat
 * `{ event, message }`.
 */
export const WebhookEventSchema = z.looseObject({
  event: softString,
  type: softString,
  message: CommsMessageSchema.optional().catch(undefined),
  data: z
    .looseObject({ message: CommsMessageSchema.optional().catch(undefined) })
    .optional()
    .catch(undefined),
});
export type WebhookEvent = z.infer<typeof WebhookEventSchema>;

/** Event names that carry an inbound message from a human. */
const INBOUND_EVENT_NAMES = new Set(["message.received"]);

/** Pull the message out of either envelope shape. */
export function messageFromWebhookEvent(
  event: WebhookEvent,
): CommsMessage | undefined {
  return event.message ?? event.data?.message;
}

/**
 * Whether an event should become a turn.
 *
 * Belt and suspenders: the event name must be an inbound one AND the message
 * must be `direction: "inbound"`. `message.sent` echoes our own replies back,
 * and feeding those in would have the assistant answer itself.
 */
export function isInboundMessageEvent(event: WebhookEvent): boolean {
  const name = event.event ?? event.type;
  if (!name || !INBOUND_EVENT_NAMES.has(name)) return false;
  return messageFromWebhookEvent(event)?.direction === "inbound";
}

/** First non-empty value among several candidate spellings. */
export function pickFirstString(
  ...values: (string | undefined)[]
): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/** Conversation id, whichever spelling the wire uses. */
export function conversationIdOf(message: CommsMessage): string | undefined {
  return pickFirstString(message.conversation_id, message.conversationId);
}

/** Creation timestamp, whichever spelling the wire uses. */
export function createdAtOf(message: CommsMessage): string | undefined {
  return pickFirstString(
    message.created_at,
    message.createdAt,
    message.timestamp,
  );
}

/** Keys the schema models, for {@link unknownMessageKeys}. */
const MODELLED_MESSAGE_KEYS = new Set([
  "id",
  "direction",
  "body",
  "channel",
  "conversation_id",
  "conversationId",
  "from",
  "to",
  "contact_id",
  "contactId",
  "created_at",
  "createdAt",
  "timestamp",
]);

/**
 * Wire keys this module does not model, so the UNVERIFIED guesses above can be
 * corrected against a real payload instead of a second reading of the docs.
 */
export function unknownMessageKeys(raw: unknown): string[] {
  if (typeof raw !== "object" || raw === null) return [];
  return Object.keys(raw as Record<string, unknown>)
    .filter((key) => !MODELLED_MESSAGE_KEYS.has(key))
    .sort();
}
