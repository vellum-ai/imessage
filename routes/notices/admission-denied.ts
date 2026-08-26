/**
 * `POST /x/plugins/imessage/notices/admission-denied`
 *
 * Internal notice from the gateway when a verified inbound delivery fails
 * the admission floor. Not a public ingress route. The vendor webhook is
 * never forwarded here.
 */

import { handleAdmissionDeniedNotice } from "../../src/admission-denied.ts";

export async function POST(request: Request): Promise<Response> {
  return handleAdmissionDeniedNotice(request);
}
