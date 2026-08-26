/**
 * Canned access-denial send for a sender the gateway refused to admit.
 *
 * The gateway keeps the vendor webhook away from this plugin on a floor
 * deny, because that path is free to run a turn. Only this plugin can send
 * on Linq, Photon, or Comms, so the gateway posts a structured notice here
 * instead. The reply is the same line built-in channels send. There is no
 * conversation turn.
 */

import { z } from "zod";

import type { IMessageConfig } from "./config.ts";
import { describeError } from "./providers/error-detail.ts";
import { resolveProvider } from "./providers/index.ts";
import type { MessagingProvider } from "./providers/types.ts";
import { resolveWebhookConfig } from "./webhook-route.ts";
import { ingressRoutePath } from "./webhook-endpoint.ts";

/**
 * Matches `ACCESS_DENIED_NOT_APPROVED_REPLY` in `@vellumai/gateway-client`.
 * Used when a notice omits `replyText`. Prefer the text the gateway sent
 * so both surfaces send the same line.
 */
export const ACCESS_DENIED_NOT_APPROVED_REPLY =
  "Sorry, you haven't been approved to message this assistant.";

const NoticeSchema = z.object({
  reason: z.literal("admission_floor"),
  plugin: z.string().min(1),
  ingressRoute: z.string().min(1),
  conversationExternalId: z.string().min(1),
  externalMessageId: z.string().min(1),
  replyText: z.string().min(1).optional(),
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export interface AdmissionDeniedNoticeDeps {
  durablePath?: string;
  config?: IMessageConfig;
  provider?: MessagingProvider;
}

/**
 * Send the canned denial to the chat the gateway already refused.
 *
 * The configured provider has to match the ingress route the notice names.
 * A leftover Linq registration after a switch to Photon cannot send into a
 * Linq chat, and retrying that notice will not change the provider.
 */
export async function handleAdmissionDeniedNotice(
  request: Request,
  deps: AdmissionDeniedNoticeDeps = {},
): Promise<Response> {
  const config = deps.config ?? resolveWebhookConfig(deps.durablePath);

  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return json(400, { error: "unparsable body" });
  }

  const notice = NoticeSchema.safeParse(parsed);
  if (!notice.success) {
    return json(400, { error: "invalid notice" });
  }

  if (notice.data.ingressRoute !== ingressRoutePath(config.provider)) {
    return json(200, { ok: true, ignored: "provider is not configured" });
  }

  const provider = deps.provider ?? resolveProvider({ config });

  const replyText =
    notice.data.replyText ?? ACCESS_DENIED_NOT_APPROVED_REPLY;

  try {
    await provider.send(
      { to: notice.data.conversationExternalId },
      replyText,
      { idempotencyKey: `deny:${notice.data.externalMessageId}` },
    );
  } catch (error) {
    return json(502, {
      error: "could not send the admission denial",
      detail: describeError(error),
    });
  }

  return json(200, { ok: true });
}
