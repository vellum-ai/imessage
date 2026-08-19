/**
 * BYOK provider — the user's own Comms by Osis workspace and API key.
 *
 * Everything Comms-specific lives behind this adapter: the REST client, the
 * tolerant ingress schemas, and the normalizer. Nothing above the provider
 * seam imports from this directory.
 */

import { CommsClient } from "./client.ts";
import { classifyCommsWebhook, normalizeCommsMessage } from "./normalize.ts";
import {
  COMMS_WEBHOOK_EVENTS,
  createdAtOf,
  webhookHasRequiredEvents,
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
  WebhookDelivery,
  WebhookRegistration,
} from "../types.ts";
import type { PluginInboundEvent } from "../../channel/contract.ts";
import { resolveApiKey } from "../../config.ts";
import { pickWebhookRegistration } from "../../webhook-endpoint.ts";

export function createCommsProvider(): MessagingProvider {
  const client = new CommsClient();

  return {
    id: "comms",
    label: "Comms by Osis (your own account)",
    supportsPolling: true,
    supportsLive: false,

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
     * Subscribes to `comms.message.received` and `comms.ping`. Not
     * `comms.message.sent`: those are our own replies echoed back, and the
     * normalizer drops every one. Ping is what the dashboard Send test posts;
     * without it the delivery sits pending with zero attempts.
     *
     * The signing secret comes back from both the create and the listing, so
     * an existing registration that already covers both events hands its
     * secret over rather than being torn down: `opts.hasSecret` is
     * deliberately unused here. A listing that names events but is missing
     * ping is deleted and recreated so Send test starts working without a
     * dashboard round trip.
     *
     * Matching ignores a trailing slash. See {@link sameWebhookUrl}. Without
     * that, a registration stored as `events-comms/` reads as a different
     * address, this creates a second one beside it, and both deliver under
     * different secrets.
     */
    async ensureWebhook(
      opts: EnsureWebhookOptions,
    ): Promise<WebhookRegistration> {
      const existing = pickWebhookRegistration(
        webhooksFromListing(await client.listWebhooks()),
        opts.url,
        webhookUrlOf,
      );
      if (existing && webhookHasRequiredEvents(existing)) {
        return { created: false, id: existing.id, secret: existing.secret };
      }
      if (existing?.id) {
        await client.deleteWebhook(existing.id);
      }

      const created = webhookFromCreate(
        await client.createWebhook(opts.url, [...COMMS_WEBHOOK_EVENTS]),
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
        idempotencyKey: sendOpts.idempotencyKey,
      });
      return { id: message?.id };
    },

    classifyWebhook(raw: unknown, receivedAt: string): WebhookDelivery {
      return classifyCommsWebhook(raw, receivedAt);
    },
  };
}
