/**
 * `POST /webhooks/plugins/imessage/events-comms` — deliveries from a Comms
 * line.
 *
 * Comms signs with `X-Osis-Signature: sha256=<hex>` over the raw body, which
 * `channels/ingress.json` describes to the gateway as an `hmac` route. The
 * handler never sees an unverified delivery.
 */

import { handleProviderWebhook } from "../src/webhook-route.ts";

export async function POST(request: Request): Promise<Response> {
  return handleProviderWebhook("comms", request);
}
