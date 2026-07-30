/**
 * `POST /webhooks/plugins/imessage/events` — inbound message webhooks.
 *
 * Reached through the ingress declaration in `channels/ingress.json`, which a
 * guardian approves before the gateway serves it.
 *
 * The gateway authenticates the delivery before this handler runs: signature
 * verification, body-size limits, and rate limiting are all its job, and
 * re-implementing them here would mean two schemes to keep in sync and one to
 * get subtly wrong. What arrives here is already-verified input, so this
 * handler only has to decide whether the payload is a turn.
 */

import { deliverInbound } from "../src/inbound.ts";
import {
  getChannel,
  getConfig,
  getInitContext,
  getProvider,
} from "../src/plugin-state.ts";

export async function POST(request: Request): Promise<Response> {
  const config = getConfig();
  const provider = getProvider();
  if (!config || !provider) {
    return json(503, { error: "plugin not initialized" });
  }
  if (config.ingressMode !== "webhook") {
    // An approved-but-unused declaration should not be a live surface.
    return json(404, { error: "webhook ingress is not enabled" });
  }

  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    // 200 rather than 400: the delivery was authentic and retrying it will not
    // make the body parse.
    return json(200, { ok: true, ignored: "unparsable body" });
  }

  const event = provider.normalizeWebhook(parsed, new Date().toISOString());
  if (!event) {
    // Delivery receipts and outbound echoes land here. Not an error.
    return json(200, { ok: true, ignored: "not an inbound message" });
  }

  const ctx = getInitContext();
  if (!ctx) {
    return json(503, { error: "plugin not initialized" });
  }

  // The turn is awaited rather than backgrounded so a provider retry sees a
  // real outcome. Comms retries on a non-2xx, and answering 200 before the
  // turn finished would turn a failed turn into a silently dropped message.
  const outcome = await deliverInbound({
    event,
    config,
    storageDir: ctx.pluginStorageDir,
    logger: ctx.logger,
    reply: async (conversationExternalId, text) => {
      const channel = getChannel();
      if (!channel) throw new Error("channel is not running");
      const result = await channel.transport.deliver(conversationExternalId, {
        text,
      });
      if (!result.ok) throw new Error(result.error ?? "delivery failed");
    },
  });

  // A refusal is still a 200: the delivery was valid and Comms retrying it
  // would not change who the sender is. Only the reason is logged, never
  // returned — telling an unadmitted sender why would confirm the line is live.
  return json(200, { ok: true, delivered: outcome.delivered });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
