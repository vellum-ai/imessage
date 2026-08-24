/**
 * Tolerant Zod schemas for everything Linq sends us.
 *
 * Linq payloads are untrusted external input, so these follow the gateway's
 * ingress rule: validate each field's type but `.optional().catch(undefined)`
 * it, so a malformed field collapses to `undefined` rather than rejecting the
 * whole payload. Only the fields the normalizer keys on for identity and
 * dedup are required.
 *
 * Shapes are taken from the Partner API v3 docs
 * (`docs.linqapp.com`, webhook version `2026-02-03`). The older `2025-01-01`
 * webhook envelope is accepted as a fallback so a subscription that omitted
 * the version query still delivers.
 */

import { z } from "zod";

/** Optional string that collapses to `undefined` when malformed. */
const softString = z.string().optional().catch(undefined);

/** Delivery service Linq reports on a message or handle. */
export const LinqServiceSchema = z.enum(["iMessage", "SMS", "RCS"]);
export type LinqService = z.infer<typeof LinqServiceSchema>;

export const LinqDirectionSchema = z.enum(["inbound", "outbound"]);
export type LinqDirection = z.infer<typeof LinqDirectionSchema>;

/** One participant handle as Linq reports it. */
export const LinqHandleSchema = z.looseObject({
  id: softString,
  handle: softString,
  service: LinqServiceSchema.optional().catch(undefined),
  is_me: z.boolean().optional().catch(undefined),
});
export type LinqHandle = z.infer<typeof LinqHandleSchema>;

/**
 * One part of a message.
 *
 * v1 only carries text. Media and link parts are accepted so they do not
 * fail the whole message, then dropped by the normalizer.
 */
export const LinqPartSchema = z.looseObject({
  type: softString,
  value: softString,
});
export type LinqPart = z.infer<typeof LinqPartSchema>;

/** A chat as `GET /v3/chats` reports it. */
export const LinqChatSchema = z.looseObject({
  id: z.string().min(1),
  updated_at: softString,
  created_at: softString,
  service: LinqServiceSchema.optional().catch(undefined),
});
export type LinqChat = z.infer<typeof LinqChatSchema>;

export const ListChatsResponseSchema = z.looseObject({
  chats: z.array(LinqChatSchema).catch([]),
  next_cursor: softString,
});
export type ListChatsResponse = z.infer<typeof ListChatsResponseSchema>;

/**
 * A message as Linq reports it on the list and send endpoints, and as the
 * `2026-02-03` webhook puts it in `data`.
 *
 * Required: `id`. Direction is derived from `direction` or `is_from_me`
 * because the two endpoints disagree on which they send.
 */
export const LinqMessageSchema = z.looseObject({
  id: z.string().min(1),
  chat_id: softString,
  direction: LinqDirectionSchema.optional().catch(undefined),
  is_from_me: z.boolean().optional().catch(undefined),
  created_at: softString,
  sent_at: softString,
  from: softString,
  from_handle: LinqHandleSchema.optional().catch(undefined),
  sender_handle: LinqHandleSchema.optional().catch(undefined),
  parts: z.array(LinqPartSchema).optional().catch(undefined),
  service: LinqServiceSchema.optional().catch(undefined),
  chat: z
    .looseObject({
      id: softString,
      is_group: z.boolean().optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
});
export type LinqMessage = z.infer<typeof LinqMessageSchema>;

export const ListMessagesResponseSchema = z.looseObject({
  messages: z.array(LinqMessageSchema).catch([]),
  next_cursor: softString,
});
export type ListMessagesResponse = z.infer<typeof ListMessagesResponseSchema>;

/** `POST /v3/messages` and `POST /v3/chats/{id}/messages`. */
export const SendMessageResponseSchema = z.looseObject({
  chat_id: softString,
  message: LinqMessageSchema.optional().catch(undefined),
});
export type SendMessageResponse = z.infer<typeof SendMessageResponseSchema>;

export const ListPhoneNumbersResponseSchema = z.looseObject({
  phone_numbers: z
    .array(z.looseObject({ phone_number: softString, id: softString }))
    .catch([]),
});

/**
 * The webhook envelope every Linq delivery shares.
 *
 * `2026-02-03` puts the message fields on `data` itself. `2025-01-01` nests
 * them under `data.message` and names the sender `from`. Both are accepted.
 */
export const LinqWebhookEventSchema = z.looseObject({
  event_type: softString,
  event: softString,
  type: softString,
  event_id: softString,
  data: z
    .looseObject({
      id: softString,
      chat_id: softString,
      direction: LinqDirectionSchema.optional().catch(undefined),
      is_from_me: z.boolean().optional().catch(undefined),
      from: softString,
      from_handle: LinqHandleSchema.optional().catch(undefined),
      sender_handle: LinqHandleSchema.optional().catch(undefined),
      parts: z.array(LinqPartSchema).optional().catch(undefined),
      service: LinqServiceSchema.optional().catch(undefined),
      chat: z
        .looseObject({ id: softString })
        .optional()
        .catch(undefined),
      message: LinqMessageSchema.optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
});
export type LinqWebhookEvent = z.infer<typeof LinqWebhookEventSchema>;

/** The event this channel subscribes to for inbound messages. */
export const LINQ_INBOUND_EVENT = "message.received";

/**
 * Events this channel registers for.
 *
 * Received is inbound. Sent is omitted on purpose: those are our own replies
 * echoed back.
 */
export const LINQ_WEBHOOK_EVENTS = [LINQ_INBOUND_EVENT] as const;

/**
 * Payload version pinned on every registration URL.
 *
 * Linq versions webhook bodies by `?version=YYYY-MM-DD` on the subscription
 * URL. Pinning this is what keeps `data.sender_handle` / `data.chat.id`
 * stable. A subscription created without it uses whatever is latest at
 * create time, which can change later.
 */
export const LINQ_WEBHOOK_VERSION = "2026-02-03";

const INBOUND_EVENT_NAMES = new Set([LINQ_INBOUND_EVENT]);

/** Event name as the envelope spelled it. */
export function eventNameOf(event: LinqWebhookEvent): string | undefined {
  return event.event_type ?? event.event ?? event.type;
}

/** Whether an event is an inbound message from a human. */
export function isInboundMessageEvent(event: LinqWebhookEvent): boolean {
  const name = eventNameOf(event);
  return name !== undefined && INBOUND_EVENT_NAMES.has(name);
}

/**
 * The message record out of either webhook version.
 *
 * `2026-02-03` is the message itself under `data`. `2025-01-01` wraps it as
 * `data.message` and puts the sender on `data.from`. The wrapper is merged
 * over the nested message so a fallback field on the envelope still wins
 * when the nested object omitted it.
 */
export function messageFromWebhookEvent(
  event: LinqWebhookEvent,
): LinqMessage | undefined {
  const data = event.data;
  if (!data) {
    return undefined;
  }

  const nested = data.message;
  const merged = {
    ...(nested ?? {}),
    id: data.id ?? nested?.id,
    chat_id: data.chat_id ?? data.chat?.id ?? nested?.chat_id,
    direction: data.direction ?? nested?.direction,
    is_from_me: data.is_from_me ?? nested?.is_from_me,
    from: data.from ?? nested?.from,
    from_handle: data.from_handle ?? nested?.from_handle,
    sender_handle: data.sender_handle ?? nested?.sender_handle,
    parts: data.parts ?? nested?.parts,
    service: data.service ?? nested?.service,
    chat: data.chat ?? nested?.chat,
  };

  return LinqMessageSchema.safeParse(merged).data;
}

export const LinqWebhookSubscriptionSchema = z.looseObject({
  id: softString,
  target_url: softString,
  url: softString,
  signing_secret: softString,
  secret: softString,
  is_active: z.boolean().optional().catch(undefined),
  subscribed_events: z.array(z.string()).optional().catch(undefined),
  events: z.array(z.string()).optional().catch(undefined),
});
export type LinqWebhookSubscription = z.infer<
  typeof LinqWebhookSubscriptionSchema
>;

export const CreateWebhookResponseSchema = LinqWebhookSubscriptionSchema;

/**
 * The created subscription out of the 201.
 *
 * The documented response is the subscription object itself. A `{ webhook }`
 * or `{ subscription }` wrap is accepted as a fallback because reading the
 * secret out of the wrong nesting means storing nothing and failing every
 * later verification with a registration that looks fine.
 */
export function subscriptionFromCreate(
  raw: unknown,
): LinqWebhookSubscription | undefined {
  const direct = LinqWebhookSubscriptionSchema.safeParse(raw);
  if (direct.success && (direct.data.id || direct.data.signing_secret)) {
    return direct.data;
  }
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  for (const key of ["subscription", "webhook"]) {
    const nested = LinqWebhookSubscriptionSchema.safeParse(record[key]);
    if (nested.success) {
      return nested.data;
    }
  }
  return undefined;
}

export const ListWebhooksResponseSchema = z.union([
  z.array(LinqWebhookSubscriptionSchema),
  z.looseObject({
    subscriptions: z
      .array(LinqWebhookSubscriptionSchema)
      .optional()
      .catch(undefined),
    webhooks: z.array(LinqWebhookSubscriptionSchema).optional().catch(undefined),
    data: z.array(LinqWebhookSubscriptionSchema).optional().catch(undefined),
  }),
]);

/** Registered subscriptions out of whichever envelope the listing used. */
export function subscriptionsFromListing(
  raw: unknown,
): LinqWebhookSubscription[] {
  const parsed = ListWebhooksResponseSchema.safeParse(raw);
  if (!parsed.success) {
    return [];
  }
  if (Array.isArray(parsed.data)) {
    return parsed.data;
  }
  return (
    parsed.data.subscriptions ?? parsed.data.webhooks ?? parsed.data.data ?? []
  );
}

/** The registered URL, whichever spelling the wire uses. */
export function subscriptionUrlOf(
  hook: LinqWebhookSubscription,
): string | undefined {
  return pickFirstString(hook.target_url, hook.url);
}

/** Signing secret Linq issued, present only on create. */
export function signingSecretOf(
  hook: LinqWebhookSubscription,
): string | undefined {
  return pickFirstString(hook.signing_secret, hook.secret);
}

/**
 * Whether a listed subscription already covers the events this channel needs.
 *
 * A listing that omits events is treated as already covering them: rotating
 * the secret on every start because the listing did not say would be worse
 * than leaving a rare omitted-field registration alone.
 */
export function subscriptionHasRequiredEvents(
  hook: LinqWebhookSubscription,
): boolean {
  const events = hook.subscribed_events ?? hook.events;
  if (!events) {
    return true;
  }
  return LINQ_WEBHOOK_EVENTS.every((event) => events.includes(event));
}

/** First non-empty value among several candidate spellings. */
export function pickFirstString(
  ...values: (string | undefined)[]
): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

/** Conversation id, from either webhook version or a list row. */
export function conversationIdOf(message: LinqMessage): string | undefined {
  return pickFirstString(message.chat_id, message.chat?.id);
}

/** Sender handle, from either webhook version or a list row. */
export function senderHandleOf(message: LinqMessage): string | undefined {
  return pickFirstString(
    message.sender_handle?.handle,
    message.from_handle?.handle,
    message.from,
  );
}

/** Creation timestamp used to advance the poll cursor. */
export function createdAtOf(message: LinqMessage): string | undefined {
  return pickFirstString(message.created_at, message.sent_at);
}

/**
 * Whether this record is an inbound message from someone else.
 *
 * List rows use `is_from_me`. Webhooks use `direction`. Either being an
 * outbound echo is enough to drop the record.
 */
export function isInboundMessage(message: LinqMessage): boolean {
  if (message.direction === "outbound" || message.is_from_me === true) {
    return false;
  }
  if (message.direction === "inbound" || message.is_from_me === false) {
    return true;
  }
  return false;
}

/** Concatenate the text parts, or `undefined` when there is no text. */
export function textFromParts(message: LinqMessage): string | undefined {
  const texts = (message.parts ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.value?.trim())
    .filter((value): value is string => Boolean(value));
  if (texts.length === 0) {
    return undefined;
  }
  return texts.join("\n");
}

/**
 * Pin Linq's webhook payload version on a registration URL.
 *
 * Query-bearing URLs keep any existing params and overwrite `version`. A
 * trailing slash on the path is preserved, which is what the managed
 * callback layer needs so the POST does not 301.
 */
export function withLinqWebhookVersion(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("version", LINQ_WEBHOOK_VERSION);
  return parsed.toString();
}
