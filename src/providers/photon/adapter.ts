/**
 * BYO provider — the user's own Photon (Spectrum) project.
 *
 * Everything Photon-specific lives behind this adapter: the two-plane client,
 * the tolerant schemas, and the normalizer. Nothing above the provider seam
 * imports from this directory.
 *
 * The one shape difference worth knowing from outside: Photon addresses a
 * conversation by chat guid (`any;-;+15551234567`), not by phone number. A
 * reply already has one — the webhook's space id is that guid — so the common
 * path costs nothing. Only a cold send to a bare handle has to resolve a chat
 * first, and that resolution carries the message with it.
 */

import { PhotonClient } from "./client.ts";
import type { MessageClientFactory } from "./message-client.ts";
import { normalizePhotonMessage, normalizeWebhookEvent } from "./normalize.ts";
import type {
  EnsureWebhookOptions,
  FetchInboundOptions,
  InboundRecord,
  MessagingProvider,
  SendResult,
  SendTarget,
  WebhookRegistration,
} from "../types.ts";
import type { PluginInboundEvent } from "../../channel/contract.ts";

/** A chat guid, as opposed to a handle we would have to resolve one for. */
function isChatGuid(value: string): boolean {
  return value.includes(";");
}

export function createPhotonProvider(
  /** Injected by tests so a send never opens a real gRPC channel. */
  makeMessageClient?: MessageClientFactory,
): MessagingProvider {
  const client = new PhotonClient(makeMessageClient);

  /**
   * Chat guids resolved for a bare handle, for this provider's lifetime.
   *
   * A long reply is several sends to the same recipient — the skill script and
   * the transport both chunk — and without this each chunk would re-resolve
   * the same chat before it could go out. Same reasoning as the client's token
   * cache: a guid is stable for a set of participants, and a wrong one
   * surfaces immediately as a failed send rather than as a silent misdelivery.
   */
  const chatGuids = new Map<string, string>();

  return {
    id: "photon",
    label: "Photon (your own project)",
    supportsPolling: true,

    /**
     * Both credentials plus a live control-plane call.
     *
     * Stopping at "the credentials are stored" would report ready for a
     * project id that was mistyped, and the first symptom would be a silently
     * dead line. `getProject` is the cheapest call that proves the pair works.
     */
    async checkReadiness() {
      try {
        await client.getProject();
        return { ready: true as const };
      } catch (err) {
        return {
          ready: false as const,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    },

    async fetchInbound(
      fetchOpts: FetchInboundOptions,
    ): Promise<InboundRecord[]> {
      const response = await client.listRecent({
        ...(fetchOpts.since ? { after: new Date(fetchOpts.since) } : {}),
        limit: fetchOpts.limit,
        isFromMe: false,
      });

      return response.messages.map((message) => ({
        id: message.guid,
        // The cursor is stored as a string; the SDK decodes protobuf
        // timestamps into `Date`, so this is where the two meet.
        createdAt: message.dateCreated.toISOString(),
        // Normalizing here, inside the adapter, is what keeps the poller
        // provider-agnostic: it never sees a Photon-shaped payload.
        event: normalizePhotonMessage(message, new Date().toISOString()),
      }));
    },

    /**
     * Register, or re-register when the signing secret is gone.
     *
     * Photon returns the secret exactly once, at creation, and its listing
     * never carries it. So a registration that exists while this plugin holds
     * no secret is worse than none: deliveries arrive and nothing can verify
     * them. Deleting and recreating is the only way back to a verifiable
     * webhook, and Photon's own docs say the same.
     */
    async ensureWebhook(
      opts: EnsureWebhookOptions,
    ): Promise<WebhookRegistration> {
      const existing = (await client.listWebhooks()).find(
        (hook) => hook.webhookUrl === opts.url,
      );

      if (existing && opts.hasSecret) {
        return { created: false, id: existing.id };
      }
      if (existing?.id) {
        await client.deleteWebhook(existing.id);
      }

      const created = await client.createWebhook(opts.url);
      return {
        created: true,
        id: created?.id,
        secret: created?.signingSecret,
      };
    },

    /**
     * Send, resolving a chat first only when the target is a bare handle.
     *
     * `idempotencyKey` rides as `clientMessageId` and as the
     * `x-idempotency-key` header, so a retry after a timeout does not deliver
     * twice — on a real phone line the recipient sees both.
     */
    async send(
      target: SendTarget,
      body: string,
      sendOpts: { idempotencyKey: string },
    ): Promise<SendResult> {
      const addressed =
        "conversationId" in target ? target.conversationId : target.to;
      const known = isChatGuid(addressed)
        ? addressed
        : chatGuids.get(addressed);

      if (known) {
        const message = await client.sendText({
          chatGuid: known,
          text: body,
          clientMessageId: sendOpts.idempotencyKey,
        });
        return { id: message?.guid };
      }

      // A handle with no chat resolved yet: create-or-resolve the chat and
      // send the opening message in the same call rather than paying two round
      // trips.
      const created = await client.createChat({
        addresses: [addressed],
        clientMessageId: sendOpts.idempotencyKey,
        text: body,
      });
      if (created.chatGuid) chatGuids.set(addressed, created.chatGuid);

      if (created.message) return { id: created.message.guid };

      // The chat resolved but carried no message back. Send explicitly rather
      // than reporting a delivery that may not have happened.
      if (created.chatGuid) {
        const message = await client.sendText({
          chatGuid: created.chatGuid,
          text: body,
          clientMessageId: sendOpts.idempotencyKey,
        });
        return { id: message?.guid };
      }

      throw new Error(
        `Photon could not resolve a chat for ${addressed}, so the message was not sent`,
      );
    },

    normalizeWebhook(
      raw: unknown,
      receivedAt: string,
    ): PluginInboundEvent | undefined {
      return normalizeWebhookEvent(raw, receivedAt);
    },

    async close(): Promise<void> {
      chatGuids.clear();
      await client.close();
    },
  };
}
