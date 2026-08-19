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

/**
 * The event this channel subscribes to for inbound messages, as
 * `POST /webhooks` names it.
 *
 * Documented at `docs.osis.co/messages-api/create-webhook` alongside
 * `comms.message.sent`, which this channel deliberately does not subscribe to.
 */
export const COMMS_INBOUND_EVENT = "comms.message.received";

/**
 * Comms' delivery test, as `POST /webhooks/{id}/test` and the dashboard
 * Send test post it.
 *
 * A webhook that is not subscribed to this event never sees the ping: Comms
 * leaves it pending with zero attempts rather than posting it.
 */
export const COMMS_PING_EVENT = "comms.ping";

/**
 * Events this channel registers for.
 *
 * Received is inbound. Ping is the vendor's signed delivery test. Sent is
 * omitted on purpose: those are our own replies echoed back.
 */
export const COMMS_WEBHOOK_EVENTS = [
  COMMS_INBOUND_EVENT,
  COMMS_PING_EVENT,
] as const;

/**
 * Event names that carry an inbound message from a human.
 *
 * The registration name is documented; what the delivery envelope puts in its
 * `event` field is not, so the unprefixed spelling is accepted too. Guessing
 * wrong in the strict direction would drop every inbound message.
 */
const INBOUND_EVENT_NAMES = new Set([COMMS_INBOUND_EVENT, "message.received"]);

/**
 * Comms' delivery test, as `POST /webhooks/{id}/test` sends it.
 *
 * It travels the real pipeline — same envelope, same signature — so reaching
 * this plugin proves registration, the signing secret and the gateway route
 * all work. Both spellings for the same reason the inbound names have both:
 * the registration name is documented, the envelope's is not.
 */
const PING_EVENT_NAMES = new Set([COMMS_PING_EVENT, "ping"]);

/** Whether an event is the vendor confirming it can reach us. */
export function isPingEvent(event: WebhookEvent): boolean {
  const name = event.event ?? event.type;
  return name !== undefined && PING_EVENT_NAMES.has(name);
}

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

/**
 * A registered webhook.
 *
 * `secret` (`whsec_…`) is the HMAC key Comms signs deliveries with. It comes
 * back from `POST /webhooks` **and** from `GET /webhooks`, which is the useful
 * difference from Photon: a lost secret is re-readable, so a registration never
 * has to be torn down to recover one.
 *
 * The url is accepted under several spellings. Getting it wrong means
 * `ensureWebhook` never matches an existing registration and registers a
 * duplicate on every start, so the candidates are wide rather than a single
 * guess.
 */
export const CommsWebhookSchema = z.looseObject({
  id: softString,
  url: softString,
  webhook_url: softString,
  webhookUrl: softString,
  secret: softString,
  events: z.array(z.string()).optional().catch(undefined),
});
export type CommsWebhook = z.infer<typeof CommsWebhookSchema>;

/** `POST /webhooks`, whose 201 wraps the created object. */
export const CreateWebhookResponseSchema = z.looseObject({
  webhook: CommsWebhookSchema,
});

/**
 * The created webhook out of the 201.
 *
 * The documented response wraps it as `{ webhook }`; a bare object is accepted
 * as a fallback because reading the secret out of the wrong nesting means
 * storing nothing and failing every later verification with a registration
 * that looks fine.
 */
export function webhookFromCreate(raw: unknown): CommsWebhook | undefined {
  const wrapped = CreateWebhookResponseSchema.safeParse(raw);
  if (wrapped.success) return wrapped.data.webhook;
  return CommsWebhookSchema.safeParse(raw).data;
}

/** `GET /webhooks`, which may answer with a bare array or a wrapped one. */
export const ListWebhooksResponseSchema = z.union([
  z.array(CommsWebhookSchema),
  z.looseObject({
    webhooks: z.array(CommsWebhookSchema).optional().catch(undefined),
    data: z.array(CommsWebhookSchema).optional().catch(undefined),
  }),
]);

/** Registered webhooks out of whichever envelope the listing used. */
export function webhooksFromListing(raw: unknown): CommsWebhook[] {
  const parsed = ListWebhooksResponseSchema.safeParse(raw);
  if (!parsed.success) return [];
  if (Array.isArray(parsed.data)) return parsed.data;
  return parsed.data.webhooks ?? parsed.data.data ?? [];
}

/** The registered URL, whichever spelling the wire uses. */
export function webhookUrlOf(hook: CommsWebhook): string | undefined {
  return pickFirstString(hook.url, hook.webhook_url, hook.webhookUrl);
}

/**
 * Whether a listed webhook already covers the events this channel needs.
 *
 * A listing that omits `events` is treated as already covering them: rotating
 * the secret on every start because the listing did not say would be worse
 * than leaving a rare omitted-field registration alone. A listing that names
 * events but is missing ping or received does not cover them.
 */
export function webhookHasRequiredEvents(hook: CommsWebhook): boolean {
  const events = hook.events;
  if (!events) {
    return true;
  }
  return COMMS_WEBHOOK_EVENTS.every((event) => events.includes(event));
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
