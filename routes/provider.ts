/**
 * `POST /x/plugins/imessage/provider`: switch the messaging provider
 * (vellum or comms).
 *
 * Deliberately separate from the settings PATCH: after the config write the
 * old ingress is torn down and the new one spun up immediately. Posting the
 * active provider bounces it.
 */

import { handleProviderPost } from "../src/app-routes.ts";

export async function POST(request: Request): Promise<Response> {
  return handleProviderPost(request);
}
