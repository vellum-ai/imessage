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
  CommsWebhookSchema,
  createdAtOf,
  webhookUrlOf,
  webhooksFromListing,
} from "./schemas.ts";
import type {
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
     * `message.received` only. Registering for `message.sent` would deliver
     * our own replies straight back, and the normalizer would drop every one
     * of them — traffic and log noise for nothing.
     */
    async ensureWebhook(url: string): Promise<WebhookRegistration> {
      const existing = webhooksFromListing(await client.listWebhooks()).find(
        (hook) => webhookUrlOf(hook) === url,
      );
      if (existing) return { created: false, id: existing.id };

      const created = await client.createWebhook(url, ["message.received"]);
      return {
        created: true,
        id: CommsWebhookSchema.safeParse(created).data?.id,
      };
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
