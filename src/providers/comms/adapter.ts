/**
 * BYOK provider — the user's own Comms by Osis workspace and API key.
 *
 * Everything Comms-specific lives behind this adapter: the REST client, the
 * tolerant ingress schemas, and the normalizer. Nothing above the provider
 * seam imports from this directory.
 */

import { CommsClient } from "./client.ts";
import { normalizeCommsMessage, normalizeWebhookEvent } from "./normalize.ts";
import { createdAtOf } from "./schemas.ts";
import type {
  FetchInboundOptions,
  InboundRecord,
  MessagingProvider,
  SendResult,
  SendTarget,
} from "../types.ts";
import type { PluginInboundEvent } from "../../channel/contract.ts";
import type { CommsChannel } from "./schemas.ts";

export interface CommsAdapterOptions {
  /** Resolves the user's stored Comms API key. */
  getApiKey: () => Promise<string>;
  /** Forced delivery channel, or `undefined` to let Comms choose. */
  sendChannel?: CommsChannel;
  /** Injectable for tests. */
  client?: CommsClient;
}

export function createCommsProvider(
  opts: CommsAdapterOptions,
): MessagingProvider {
  const client = opts.client ?? new CommsClient(opts.getApiKey);

  return {
    id: "comms",
    label: "Comms by Osis (your own account)",
    supportsPolling: true,

    async checkReadiness() {
      try {
        await opts.getApiKey();
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
