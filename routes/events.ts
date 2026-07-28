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

import { isAllowedHandle } from "../src/config.ts";
import { getConfig, getProvider } from "../src/plugin-state.ts";

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

  if (!isAllowedHandle(config, event.actor.actorExternalId)) {
    return json(200, { ok: true, ignored: "handle outside the allowlist" });
  }

  // TODO(pluggable-channels): forward to the host's inbound pipeline so the
  // event runs through the kill switch, trust classification, and the
  // admission floor. See the matching note in hooks/init.ts.
  return json(200, { ok: true });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
