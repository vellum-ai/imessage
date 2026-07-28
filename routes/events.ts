/**
 * `POST /webhooks/plugins/imessage/events` — inbound message webhooks.
 *
 * Reached through the ingress declaration in `channels/ingress.json`, which a
 * guardian must approve before the gateway serves it.
 *
 * This route is unauthenticated ingress from the public internet, so it fails
 * closed at every step: no signing secret stored, no signature header, a stale
 * timestamp, or a digest mismatch all reject before the body is parsed as
 * anything meaningful. An inbound-message route anyone can POST to is a way to
 * impersonate a trusted contact, so "accept it and let the gateway sort it
 * out" is not an option.
 *
 * Enabled only when `ingressMode` is `"webhook"`. In the default `poll` mode
 * the route answers 404 so an approved-but-unused declaration is not a live
 * surface.
 */

import { normalizeWebhookEvent } from "../src/channel/normalize.ts";
import { verifyWebhookSignature, SIGNATURE_HEADER } from "../src/comms/signature.ts";
import { isAllowedHandle, resolveWebhookSecret } from "../src/config.ts";
import { getConfig } from "../src/plugin-state.ts";

/**
 * Cap on the body we will read. The gateway enforces its own webhook payload
 * limit upstream; this is the plugin's own belt.
 */
const MAX_BODY_BYTES = 128 * 1024;

export async function POST(request: Request): Promise<Response> {
  const config = getConfig();
  if (!config) {
    return json(503, { error: "plugin not initialized" });
  }
  if (config.ingressMode !== "webhook") {
    return json(404, { error: "webhook ingress is not enabled" });
  }

  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    return json(413, { error: "payload too large" });
  }

  const verification = verifyWebhookSignature({
    rawBody,
    signatureHeader: request.headers.get(SIGNATURE_HEADER),
    secret: await resolveWebhookSecret(),
  });
  if (!verification.ok) {
    // The reason is deliberately not echoed to the caller — it would tell an
    // attacker which check they failed.
    return json(401, { error: "signature verification failed" });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    // 200 rather than 400: the delivery was authentic, the body was not
    // usable, and Comms should not retry it forever.
    return json(200, { ok: true, ignored: "unparsable body" });
  }

  const event = normalizeWebhookEvent(parsed, new Date().toISOString());
  if (!event) {
    // Delivery receipts and outbound echoes land here. Not an error.
    return json(200, { ok: true, ignored: "not an inbound message" });
  }

  if (!isAllowedHandle(config, event.actor.actorExternalId)) {
    return json(200, { ok: true, ignored: "handle outside the allowlist" });
  }

  // TODO(pluggable-channels): forward to the host's inbound pipeline so the
  // event runs through the `no_one` kill switch, trust classification, and the
  // admission floor. See the matching note in hooks/init.ts — until that entry
  // point exists, accepting the delivery without forwarding is the only
  // behavior that does not bypass admission.
  return json(200, { ok: true });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
