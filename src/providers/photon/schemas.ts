/**
 * Tolerant Zod schemas for everything Photon sends us.
 *
 * Photon answers on two planes with two different envelopes, and this module
 * models both:
 *
 * - **Control plane** (`spectrum.photon.codes`, Basic auth) wraps every answer
 *   as `{ succeed: true, data }` or `{ succeed: false, message }`. Documented
 *   in the Spectrum Cloud OpenAPI, so these shapes are pinned, not guessed.
 * - **Message plane** (`imessage.spectrum.photon.codes`, bearer auth) is
 *   protobuf-JSON: camelCase field names, RFC 3339 timestamps, absent rather
 *   than null for unset fields.
 *
 * Same ingress rule as the Comms schemas: validate each field's type but
 * `.optional().catch(undefined)` it, so a malformed field collapses instead of
 * rejecting a whole message. Only what the normalizer keys on for identity and
 * dedup is required.
 *
 * Fields marked UNVERIFIED are read off the published SDK's own request and
 * response mapping rather than a documented wire contract. They are optional,
 * so a wrong guess degrades to "absent" rather than dropping a message.
 */

import { z } from "zod";

/** Optional string that collapses to `undefined` when malformed. */
const softString = z.string().optional().catch(undefined);

/* ------------------------------------------------------------------ *
 * Control plane
 * ------------------------------------------------------------------ */

/**
 * The envelope every control-plane response carries.
 *
 * `succeed` is the only field worth requiring: a failure answers
 * `{ succeed: false, message }` with no `data`, and the client turns that into
 * an error that quotes `message`.
 */
export const EnvelopeSchema = z.looseObject({
  succeed: z.boolean().catch(false),
  data: z.unknown().optional(),
  message: softString,
});
export type Envelope = z.infer<typeof EnvelopeSchema>;

/** `GET /projects/{projectId}/` */
export const ProjectSchema = z.looseObject({
  name: softString,
  slug: softString,
});
export type PhotonProject = z.infer<typeof ProjectSchema>;

/**
 * `GET /projects/{projectId}/imessage/`
 *
 * `shared` rides a pooled line, `dedicated` owns numbers. The distinction
 * decides which token shape the mint returns, so it is required.
 */
export const IMessageInfoSchema = z.looseObject({
  type: z.enum(["shared", "dedicated"]),
});
export type IMessageInfo = z.infer<typeof IMessageInfoSchema>;

/**
 * `POST /projects/{projectId}/imessage/tokens`
 *
 * Shared projects get one token. Dedicated projects get one per instance,
 * keyed by instance id, plus a parallel map of instance id to phone number —
 * the instance id then rides on every message-plane call as `x-photon-server`.
 */
export const SharedTokenSchema = z.looseObject({
  type: z.literal("shared"),
  token: z.string().min(1),
  expiresIn: z.number().optional().catch(undefined),
});

export const DedicatedTokenSchema = z.looseObject({
  type: z.literal("dedicated"),
  auth: z.record(z.string(), z.string()),
  numbers: z.record(z.string(), z.string()).optional().catch(undefined),
  expiresIn: z.number().optional().catch(undefined),
});

export const TokenResponseSchema = z.union([
  SharedTokenSchema,
  DedicatedTokenSchema,
]);
export type TokenResponse = z.infer<typeof TokenResponseSchema>;

/**
 * `GET /projects/{projectId}/webhooks/` and `POST` of the same.
 *
 * `signingSecret` comes back **only** from the POST and is never retrievable
 * afterwards — the listing omits it. That is why registration stores it
 * immediately and why a registration whose secret was lost has to be deleted
 * and recreated rather than reused: nothing can verify its deliveries.
 */
export const PhotonWebhookSchema = z.looseObject({
  id: softString,
  webhookUrl: softString,
  signingSecret: softString,
});
export type PhotonWebhook = z.infer<typeof PhotonWebhookSchema>;

export const ListWebhooksResponseSchema = z.array(PhotonWebhookSchema);

/* ------------------------------------------------------------------ *
 * Message plane
 * ------------------------------------------------------------------ */

/** An address as the message plane reports it. */
export const AddressSchema = z.looseObject({
  address: softString,
  country: softString,
  /** `iMessage`, `SMS`, `RCS`, or a numeric protobuf enum. UNVERIFIED spelling. */
  service: z.union([z.string(), z.number()]).optional().catch(undefined),
});

export const MessageContentSchema = z.looseObject({
  text: softString,
});

/**
 * A message on the wire.
 *
 * Required: `guid` (dedup key) and `isFromMe` (an outbound echo must never be
 * replayed into the assistant as user input — and unlike a missing text body,
 * guessing this one wrong is what makes the assistant answer itself).
 */
export const PhotonMessageSchema = z.looseObject({
  guid: z.string().min(1),
  isFromMe: z.boolean(),
  content: MessageContentSchema.optional().catch(undefined),
  chatGuids: z.array(z.string()).optional().catch(undefined),
  sender: AddressSchema.optional().catch(undefined),
  dateCreated: softString,
  /** Set on tapbacks and edits; those are not turns. UNVERIFIED. */
  reactionTargetGuid: softString,
  isSystemMessage: z.boolean().optional().catch(undefined),
  isServiceMessage: z.boolean().optional().catch(undefined),
});
export type PhotonMessage = z.infer<typeof PhotonMessageSchema>;

/** `POST /v1/messages:sendText` and `POST /v1/chats` (its `initialMessage`). */
export const SendTextResponseSchema = z.looseObject({
  message: PhotonMessageSchema.optional().catch(undefined),
});

export const ChatSchema = z.looseObject({
  guid: z.string().min(1),
});

export const CreateChatResponseSchema = z.looseObject({
  chat: ChatSchema.optional().catch(undefined),
  initialMessage: PhotonMessageSchema.optional().catch(undefined),
});

/** `GET /v1/messages:listRecent` */
export const ListMessagesResponseSchema = z.looseObject({
  messages: z.array(PhotonMessageSchema).catch([]),
  nextPageToken: softString,
});
export type ListMessagesResponse = z.infer<typeof ListMessagesResponseSchema>;

/* ------------------------------------------------------------------ *
 * Webhooks
 * ------------------------------------------------------------------ */

/**
 * A `messages` webhook delivery.
 *
 * Documented shape, unlike the Comms envelope: `space` is where it landed,
 * `message.sender` is who sent it, and `direction` is always `inbound`
 * (Photon does not deliver outbound echoes at all). The plugin still checks
 * direction rather than trusting that — a provider that starts sending echoes
 * must not turn the assistant into its own correspondent.
 */
export const WebhookSpaceSchema = z.looseObject({
  id: softString,
  platform: softString,
  /** `dm` or `group`. */
  type: softString,
  /** The line the message landed on. */
  phone: softString,
});

export const WebhookMessageSchema = z.looseObject({
  id: z.string().min(1),
  platform: softString,
  direction: softString,
  timestamp: softString,
  sender: z
    .looseObject({ id: softString, platform: softString })
    .optional()
    .catch(undefined),
  space: WebhookSpaceSchema.optional().catch(undefined),
  content: z
    .looseObject({ type: softString, text: softString })
    .optional()
    .catch(undefined),
});
export type WebhookMessage = z.infer<typeof WebhookMessageSchema>;

export const WebhookEventSchema = z.looseObject({
  event: softString,
  space: WebhookSpaceSchema.optional().catch(undefined),
  message: WebhookMessageSchema.optional().catch(undefined),
});
export type WebhookEvent = z.infer<typeof WebhookEventSchema>;

/** The only event Photon delivers today. */
const INBOUND_EVENT_NAMES = new Set(["messages"]);

export function isInboundMessageEvent(event: WebhookEvent): boolean {
  if (event.event && !INBOUND_EVENT_NAMES.has(event.event)) return false;
  const direction = event.message?.direction;
  return direction === undefined || direction === "inbound";
}

/**
 * Which chat a message belongs to.
 *
 * A message can be in several chats on iMessage; the first is the one it was
 * delivered to. Falls back to the space id from the webhook envelope.
 */
export function chatGuidOf(message: PhotonMessage): string | undefined {
  return message.chatGuids?.[0];
}

/** Provider-side creation time, used only to advance the poll cursor. */
export function createdAtOf(message: PhotonMessage): string | undefined {
  return message.dateCreated;
}
