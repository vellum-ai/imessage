/**
 * The handler behind `routes/events/<provider>.ts`.
 *
 * One route per provider, and the provider is the route's own — taken from the
 * path, never from the running config. Two reasons:
 *
 * 1. **The gateway needs it.** Which provider signed a delivery decides how it
 *    must be verified, and the gateway reads only its static manifest. Putting
 *    the provider in the path is what lets a static declaration describe a
 *    plugin whose provider is a runtime choice.
 * 2. **The payloads differ.** A Comms delivery normalized by the Photon adapter
 *    parses as nothing at all. Binding the normalizer to the path means a
 *    delivery is always read by the adapter that understands it.
 *
 * The gateway authenticates the delivery before this handler runs: signature
 * verification, body-size limits, and rate limiting are all its job, and
 * re-implementing them here would mean two schemes to keep in sync and one to
 * get subtly wrong.
 *
 * It also reads what this handler returns. A route declaring `inbound` in
 * `channels/ingress.json` — both of these do — is one whose reply carries the
 * message, and the gateway runs that reply through the same admission pipeline
 * every built-in channel goes through. So the normalized event is the response
 * body, and a delivery that is not a turn says so by replying without one.
 */

import { getConfig } from "./plugin-state.ts";
import { resolveProvider } from "./providers/index.ts";
import type { ProviderId } from "./providers/types.ts";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function handleProviderWebhook(
  providerId: ProviderId,
  request: Request,
): Promise<Response> {
  const config = getConfig();
  if (!config) {
    return json(503, { error: "plugin not initialized" });
  }
  if (config.ingressMode !== "webhook") {
    // An approved-but-unused declaration should not be a live surface.
    return json(404, { error: "webhook ingress is not enabled" });
  }
  if (config.provider !== providerId) {
    // A registration left behind by a provider this channel no longer uses.
    // 200 rather than an error: the delivery is authentic and retrying it will
    // not change the answer, and a 4xx would have the provider retry or
    // disable a webhook whose real problem is that it is stale.
    return json(200, { ok: true, ignored: "provider is not configured" });
  }

  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    // 200 rather than 400: the delivery was authentic and retrying it will not
    // make the body parse.
    return json(200, { ok: true, ignored: "unparsable body" });
  }

  // Built for this route rather than read from plugin state. The two agree —
  // the check above guarantees it — but building from the path keeps the
  // handler correct on its own terms rather than by coincidence.
  const provider = resolveProvider({ config: { ...config, provider: providerId } });

  const event = provider.normalizeWebhook(parsed, new Date().toISOString());
  if (!event) {
    // Delivery receipts and outbound echoes land here. Not an error.
    return json(200, { ok: true, ignored: "not an inbound message" });
  }

  // The reply *is* the handoff. The gateway forwarded this delivery here after
  // verifying it, reads what comes back, and — because `channels/ingress.json`
  // declares `inbound` on this route — runs it through the kill switch, trust
  // classification, and the admission floor before anything reaches a
  // conversation. Nothing here posts a message; a plugin that could would be
  // going around all three.
  //
  // `raw` is dropped. It is part of the event contract so a normalizer can
  // hand the vendor payload to a later stage, the gateway discards it, and
  // sending it would put the whole delivery back on the wire for nobody.
  const { raw: _raw, ...delivered } = event;
  return json(200, delivered);
}
