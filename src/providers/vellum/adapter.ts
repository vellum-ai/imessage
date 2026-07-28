/**
 * Default provider — Vellum provides the line.
 *
 * The user turns the channel on and is reachable. There is no third-party
 * account to create and no key to paste, which is the whole reason this is the
 * default: it takes a user from "install" to "working" without leaving the
 * product. Comms is what runs underneath, and the user never sees that.
 *
 * The line is shared for now. A dedicated line per assistant is the direction,
 * so do not write code or copy that assumes this line belongs to exactly one
 * assistant.
 *
 * The platform surface this talks to follows the same shape as the email
 * channel, which is the closest existing analogue: the platform provisions the
 * address and outbound goes through the runtime proxy.
 *
 *   GET  /v1/assistants/{id}/imessage-lines/   list the provisioned line
 *   POST /v1/runtime-proxy/imessage/send/      send
 *
 * Inbound is webhook-only. The platform receives the provider webhook and
 * forwards it, so there is nothing for this adapter to poll — `fetchInbound`
 * throws and `supportsPolling` is false, which makes the host reject a poll
 * configuration up front instead of failing on the first tick.
 */

import { PLATFORM_LINES_PATH, PLATFORM_SEND_PATH } from "./endpoints.ts";
import type { PlatformFetch } from "./endpoints.ts";
import { normalizePlatformEvent } from "./normalize.ts";
import type {
  InboundRecord,
  MessagingProvider,
  SendResult,
  SendTarget,
} from "../types.ts";
import type { PluginInboundEvent } from "../../channel/contract.ts";

export interface VellumAdapterOptions {
  /** Authenticated call into the platform API. */
  platformFetch: PlatformFetch;
}

export function createVellumProvider(
  opts: VellumAdapterOptions,
): MessagingProvider {
  return {
    id: "vellum",
    label: "Vellum-managed line",
    supportsPolling: false,

    async checkReadiness() {
      try {
        const response = await opts.platformFetch(PLATFORM_LINES_PATH, {
          method: "GET",
        });
        if (!response.ok) {
          return {
            ready: false as const,
            reason: `platform returned ${response.status} for the assistant's iMessage line`,
          };
        }
        const body = (await response.json().catch(() => ({}))) as {
          count?: number;
          results?: unknown[];
        };
        const provisioned =
          typeof body.count === "number"
            ? body.count > 0
            : Array.isArray(body.results) && body.results.length > 0;
        return provisioned
          ? { ready: true as const }
          : {
              ready: false as const,
              reason:
                "no iMessage line is available for this assistant yet — enable the iMessage channel",
            };
      } catch (err) {
        return {
          ready: false as const,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    },

    async fetchInbound(): Promise<InboundRecord[]> {
      throw new Error(
        "the vellum provider is webhook-only; set ingressMode to 'webhook' or switch provider to 'comms'",
      );
    },

    async send(
      target: SendTarget,
      body: string,
      sendOpts: { idempotencyKey: string },
    ): Promise<SendResult> {
      const response = await opts.platformFetch(PLATFORM_SEND_PATH, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Same contract as the Comms send: a retried send after a timeout
          // must not deliver twice, and on a real phone line the recipient
          // would see both.
          "Idempotency-Key": sendOpts.idempotencyKey,
        },
        body: JSON.stringify({
          ...("to" in target
            ? { to: target.to }
            : { conversation_id: target.conversationId }),
          body,
        }),
      });

      if (!response.ok) {
        throw new Error(
          `platform iMessage send failed: ${response.status}`,
        );
      }

      const parsed = (await response.json().catch(() => ({}))) as {
        message?: { id?: string };
      };
      return { id: parsed.message?.id };
    },

    normalizeWebhook(
      raw: unknown,
      receivedAt: string,
    ): PluginInboundEvent | undefined {
      return normalizePlatformEvent(raw, receivedAt);
    },
  };
}
