/**
 * `POST /webhooks/plugins/imessage/events-comms` — deliveries from a Comms
 * line.
 *
 * Comms documents no signature and issues no signing secret, so this route is
 * declared in `channels/ingress.json` as `shared-secret`: the gateway compares
 * a token this plugin minted and registered in the URL. The handler never sees
 * an unverified delivery.
 */

import { handleProviderWebhook } from "../src/webhook-route.ts";

export async function POST(request: Request): Promise<Response> {
  return handleProviderWebhook("comms", request);
}
