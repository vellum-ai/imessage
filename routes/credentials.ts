/**
 * `POST /x/plugins/imessage/credentials`: store the selected provider's
 * credentials and restart its ingress if it is the configured one.
 *
 * There is no GET here on purpose. The settings route already reports which
 * fields are set, and a route that could return a stored secret would exist
 * only to be called by something other than this app.
 */

import { handleCredentialsPost } from "../src/app-routes.ts";

export async function POST(request: Request): Promise<Response> {
  return handleCredentialsPost(request);
}
