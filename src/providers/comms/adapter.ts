/**
 * BYOK provider — the user's own Comms by Osis workspace and API key.
 *
 * Everything Comms-specific lives behind this adapter: the REST client, the
 * tolerant ingress schemas, and the normalizer. Nothing above the provider
 * seam imports from this directory.
 */

import { CommsClient } from "./client.ts";
import { normalizeCommsMessage, normalizeWebhookEvent } from "./normalize.ts";
import {
  COMMS_INBOUND_EVENT,
  createdAtOf,
  webhookFromCreate,
  webhookUrlOf,
  webhooksFromListing,
} from "./schemas.ts";
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
import { resolveApiKey } from "../../config.ts";
import type { CommsChannel } from "./schemas.ts";

export interface CommsAdapterOptions {
  /** Forced delivery channel, or `undefined` to let Comms choose. */
  sendChannel?: CommsChannel;
}

export function createCommsProvider(
  opts: CommsAdapterOptions = {},
): MessagingProvider {
  const client = new CommsClient();

  return {
    id: "comms",
    label: "Comms by Osis (your own account)",
    supportsPolling: true,

    async checkReadiness() {
      try {
        await resolveApiKey();
        return { ready: true as const };
      } catch (err) {
        return {
          ready: false as const,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    },

    async fetchInbound(fetchOpts: FetchInboundOptions): Promise<InboundRecord[]> {
      const response = await client.listMessages({
        since: fetchOpts.since,
        direction: "inbound",
        limit: fetchOpts.limit,
      });

      return response.messages.map((message) => ({
        id: message.id,
        createdAt: createdAtOf(message),
        // Normalizing here, inside the adapter, is what keeps the poller
        // provider-agnostic: it never sees a Comms-shaped payload.
        event: normalizeCommsMessage(message, new Date().toISOString()),
      }));
    },

    /**
     * `comms.message.received` only. Registering for `comms.message.sent`
     * would deliver our own replies straight back, and the normalizer would
     * drop every one of them — traffic and log noise for nothing.
     *
     * The signing secret comes back from both the create and the listing, so
     * an existing registration hands its secret over rather than being torn
     * down: `opts.hasSecret` is deliberately unused here. A lost secret is a
     * `GET` away, and re-registering would change the webhook id for nothing.
     */
    async ensureWebhook(
      opts: EnsureWebhookOptions,
    ): Promise<WebhookRegistration> {
      const existing = webhooksFromListing(await client.listWebhooks()).find(
        (hook) => webhookUrlOf(hook) === opts.url,
      );
      if (existing) {
        return { created: false, id: existing.id, secret: existing.secret };
      }

      const created = webhookFromCreate(
        await client.createWebhook(opts.url, [COMMS_INBOUND_EVENT]),
      );
      return { created: true, id: created?.id, secret: created?.secret };
    },

    async send(
      target: SendTarget,
      body: string,
      sendOpts: { idempotencyKey: string },
    ): Promise<SendResult> {
      const message = await client.sendMessage({
        ...("to" in target
          ? { to: target.to }
          : { conversationId: target.conversationId }),
        body,
        channel: opts.sendChannel,
        idempotencyKey: sendOpts.idempotencyKey,
      });
      return { id: message?.id };
    },

    normalizeWebhook(
      raw: unknown,
      receivedAt: string,
    ): PluginInboundEvent | undefined {
      return normalizeWebhookEvent(raw, receivedAt);
    },
  };
}
