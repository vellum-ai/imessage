/**
 * `POST /webhooks/plugins/imessage/events-photon` — deliveries from a Photon
 * project.
 *
 * Photon signs with `X-Spectrum-Signature` over `v0:<timestamp>:<body>`, which
 * `channels/ingress.json` describes to the gateway as an `hmac` route. The
 * handler never sees an unverified delivery.
 */

import { handleProviderWebhook } from "../src/webhook-route.ts";

export async function POST(request: Request): Promise<Response> {
  return handleProviderWebhook("photon", request);
}
