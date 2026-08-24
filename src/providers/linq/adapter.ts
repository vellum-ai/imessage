/**
 * BYOK provider — the user's own Linq Partner API token and line.
 *
 * Everything Linq-specific lives behind this adapter: the REST client, the
 * tolerant ingress schemas, and the normalizer. Nothing above the provider
 * seam imports from this directory.
 */

import { LinqClient } from "./client.ts";
import { classifyLinqWebhook, normalizeLinqMessage } from "./normalize.ts";
import {
  createdAtOf,
  LINQ_WEBHOOK_EVENTS,
  LINQ_WEBHOOK_VERSION,
  signingSecretOf,
  subscriptionFromCreate,
  subscriptionHasRequiredEvents,
  subscriptionUrlOf,
  subscriptionsFromListing,
  withLinqWebhookVersion,
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
import { resolveLinqApiKey } from "../../config.ts";
import { pickWebhookRegistration } from "../../webhook-endpoint.ts";

/**
 * Newest chats walked on a poll.
 *
 * Linq lists messages per chat, not globally, so a poll that walked every
 * chat would fan out one request per conversation. This cap keeps a busy
 * sandbox from spending the daily quota on the poller.
 */
const POLL_CHAT_LIMIT = 10;

export function createLinqProvider(): MessagingProvider {
  const client = new LinqClient();

  return {
    id: "linq",
    label: "Linq (your own account)",
    supportsPolling: true,
    supportsLive: false,

    async checkReadiness() {
      try {
        await resolveLinqApiKey();
      } catch (err) {
        return {
          ready: false as const,
          reason: err instanceof Error ? err.message : String(err),
        };
      }

      try {
        const numbers = await client.listPhoneNumbers();
        if (numbers.length === 0) {
          return {
            ready: false as const,
            reason:
              "Linq has no phone numbers on this account. Provision a line in the Linq dashboard, then try again.",
          };
        }
        return { ready: true as const };
      } catch (err) {
        return {
          ready: false as const,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    },

    async fetchInbound(fetchOpts: FetchInboundOptions): Promise<InboundRecord[]> {
      const chats = await client.listChats({
        limit: Math.min(fetchOpts.limit, POLL_CHAT_LIMIT),
      });
      const sinceMs = fetchOpts.since
        ? Date.parse(fetchOpts.since)
        : Number.NaN;
      const records: InboundRecord[] = [];

      for (const chat of chats.chats) {
        const page = await client.listMessages({
          chatId: chat.id,
          limit: fetchOpts.limit,
        });
        for (const message of page.messages) {
          const createdAt = createdAtOf(message);
          if (
            Number.isFinite(sinceMs) &&
            createdAt &&
            Date.parse(createdAt) < sinceMs
          ) {
            continue;
          }
          records.push({
            id: message.id,
            createdAt,
            event: normalizeLinqMessage(
              { ...message, chat_id: message.chat_id ?? chat.id },
              new Date().toISOString(),
            ),
          });
        }
      }

      return records;
    },

    /**
     * Subscribes to `message.received` only.
     *
     * The signing secret comes back from create and is never on the listing,
     * so a registration whose secret we no longer hold has to be replaced.
     * `opts.hasSecret` is load-bearing for that reason.
     *
     * The URL is pinned to webhook version `2026-02-03` so the envelope the
     * gateway reads (`data.sender_handle`, `data.chat.id`) stays stable.
     */
    async ensureWebhook(
      opts: EnsureWebhookOptions,
    ): Promise<WebhookRegistration> {
      const url = withLinqWebhookVersion(opts.url);
      const existing = pickWebhookRegistration(
        subscriptionsFromListing(await client.listWebhooks()),
        url,
        subscriptionUrlOf,
      );

      if (
        existing &&
        opts.hasSecret &&
        existing.is_active !== false &&
        subscriptionHasRequiredEvents(existing)
      ) {
        return { created: false, id: existing.id };
      }

      if (existing?.id && opts.hasSecret && existing.is_active !== false) {
        await client.updateWebhook(existing.id, {
          target_url: url,
          subscribed_events: [...LINQ_WEBHOOK_EVENTS],
        });
        return { created: false, id: existing.id };
      }

      if (existing?.id) {
        await client.deleteWebhook(existing.id);
      }

      const created = subscriptionFromCreate(await client.createWebhook(url));
      return {
        created: true,
        id: created?.id,
        secret: created ? signingSecretOf(created) : undefined,
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
        idempotencyKey: sendOpts.idempotencyKey,
      });
      return { id: message?.id };
    },

    async setTyping(target: SendTarget, isTyping: boolean): Promise<void> {
      const chatId = chatIdOf(target);
      if (!chatId) {
        return;
      }
      if (isTyping) {
        await client.startTyping(chatId);
        return;
      }
      await client.stopTyping(chatId);
    },

    classifyWebhook(raw: unknown, receivedAt: string): WebhookDelivery {
      return classifyLinqWebhook(raw, receivedAt);
    },
  };
}

/**
 * A Linq chat id, or `undefined` when the target is still a bare handle.
 *
 * Typing indicators address an existing chat. A cold send to a number Linq
 * has never seen has no chat yet, and starting one just to show dots would
 * be a send's job.
 */
function chatIdOf(target: SendTarget): string | undefined {
  if ("conversationId" in target) {
    return target.conversationId;
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target.to)) {
    return target.to;
  }
  return undefined;
}

export { LINQ_WEBHOOK_VERSION };
