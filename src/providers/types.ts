/**
 * The provider seam.
 *
 * Everything above this interface — the poller, the transport, the webhook
 * route — is provider-agnostic and must stay that way. Only the adapters under
 * `src/providers/<id>/` know what a Comms message looks like or which host
 * they talk to.
 *
 * Two providers today:
 *
 * - `vellum` (default) — Vellum provides the line. The user turns the channel
 *   on and is reachable; no third-party account, no key to paste. Comms is what
 *   runs underneath, which is an implementation detail the user never sees.
 *   The line is shared for now, so nothing above this seam may assume it
 *   belongs to a single assistant.
 * - `comms` — bring your own Comms by Osis workspace and API key.
 *
 * Adding a third provider means adding a directory and a registry entry.
 * Nothing outside `src/providers/` should need to change.
 */

import type { PluginInboundEvent } from "../channel/contract.ts";

export const PROVIDER_IDS = ["vellum", "comms"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/** Where an outbound message is addressed. */
export type SendTarget = { to: string } | { conversationId: string };

/**
 * One message the poller paged over.
 *
 * `event` is absent when the record is not a turn — an outbound echo, a
 * delivery receipt, an unattributable message. The poller still advances its
 * cursor past those, so normalization has to happen inside the adapter rather
 * than after the poller hands the record back.
 */
export interface InboundRecord {
  id: string;
  /** Provider-side creation time, used only to advance the poll cursor. */
  createdAt?: string;
  event?: PluginInboundEvent;
}

export interface FetchInboundOptions {
  /** ISO-8601 lower bound. */
  since?: string;
  limit: number;
}

export interface SendResult {
  /** Provider id of the delivered message, when the send returned one. */
  id?: string;
}

/**
 * What a provider must implement to back this channel.
 *
 * Deliberately small. A provider that only supports webhooks can throw from
 * `fetchInbound`; a provider that only supports polling can return `undefined`
 * from `normalizeWebhook`. `supportsPolling` lets the host pick a working
 * ingress mode instead of finding out at runtime.
 */
export interface MessagingProvider {
  readonly id: ProviderId;
  /** Human-readable name for logs and user-facing errors. */
  readonly label: string;
  /** Whether `fetchInbound` is usable on this provider. */
  readonly supportsPolling: boolean;

  /**
   * Confirm the provider is configured and reachable.
   *
   * Called before the channel is considered live. Returning a reason rather
   * than throwing keeps "not set up yet" — the normal state right after
   * install — distinct from a genuine failure.
   */
  checkReadiness(): Promise<{ ready: true } | { ready: false; reason: string }>;

  fetchInbound(opts: FetchInboundOptions): Promise<InboundRecord[]>;

  send(
    target: SendTarget,
    body: string,
    opts: { idempotencyKey: string },
  ): Promise<SendResult>;

  /** Turn one webhook delivery into an event, or `undefined` if it is not a turn. */
  normalizeWebhook(
    raw: unknown,
    receivedAt: string,
  ): PluginInboundEvent | undefined;
}
