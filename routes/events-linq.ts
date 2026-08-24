/**
 * `POST /webhooks/plugins/imessage/events-linq` — deliveries from a Linq
 * line.
 *
 * Linq signs with Standard Webhooks (`webhook-id`, `webhook-timestamp`,
 * `webhook-signature`) over `{id}.{timestamp}.{body}`, which
 * `channels/ingress.json` describes to the gateway as a `standard-webhooks`
 * route. The handler never sees an unverified delivery.
 */

import { handleProviderWebhook } from "../src/webhook-route.ts";

export async function POST(request: Request): Promise<Response> {
  return handleProviderWebhook("linq", request);
}
