/**
 * The provider seam.
 *
 * Everything above this interface — the poller, the transport, the webhook
 * route — is provider-agnostic and must stay that way. Only the adapters under
 * `src/providers/<id>/` know what a provider's payloads look like.
 *
 * Two providers, both bring-your-own — the user holds the account and the
 * billing either way:
 *
 * - `photon` (default) — a Photon (Spectrum) project. Two planes rather than
 *   one: a control plane at `spectrum.photon.codes` authenticated with the
 *   project id and secret, and a message plane at
 *   `imessage.spectrum.photon.codes` authenticated with a short-lived token
 *   minted from it. The adapter owns that dance; nothing above this seam knows
 *   there are two hosts.
 * - `comms` — a Comms by Osis workspace, API key, and line. One REST API for
 *   both directions.
 *
 * The seam also earns its keep independently of the entry count: no official
 * iMessage API exists, every vendor runs a macOS fleet under a
 * tolerated-not-licensed arrangement, and one of them getting cut off should be
 * an adapter swap rather than a rewrite. Adding a provider means adding a
 * directory and a registry entry; nothing outside `src/providers/` changes.
 */

import type { PluginInboundEvent } from "../channel/contract.ts";

export const PROVIDER_IDS = ["photon", "comms"] as const;
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

export interface EnsureWebhookOptions {
  /** Absolute URL the provider should deliver to. */
  url: string;
  /**
   * Whether the plugin already holds this provider's signing secret.
   *
   * Load-bearing for a provider that issues one exactly once: a registration
   * that exists while the secret is lost can only be replaced, because nothing
   * can verify its deliveries.
   */
  hasSecret: boolean;
}

/** What `ensureWebhook` found or did. */
export interface WebhookRegistration {
  /** False when a usable registration for that URL was already there. */
  created: boolean;
  /** Provider-side id, when the provider returned one. */
  id?: string;
  /**
   * Signing secret the provider issued, for the caller to store.
   *
   * Present only on the call that created the registration, because that is
   * the only time a provider hands one over.
   */
  secret?: string;
}

/**
 * What a provider must implement to back this channel.
 *
 * Deliberately small. A provider that only supports webhooks can throw from
 * `fetchInbound`; `supportsPolling` lets the host pick a working ingress mode
 * instead of finding out at runtime.
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
   * Returning a reason rather than throwing keeps "not set up yet" — the normal
   * state right after install — distinct from a genuine failure.
   */
  checkReadiness(): Promise<{ ready: true } | { ready: false; reason: string }>;

  fetchInbound(opts: FetchInboundOptions): Promise<InboundRecord[]>;

  /**
   * Point the provider's webhook at `opts.url`, if it is not already.
   *
   * Registering is the plugin's job, not the gateway's: the gateway serves the
   * route but never holds provider credentials, so nothing else in the system
   * is in a position to tell Comms or Photon where to deliver.
   *
   * Implementations list first and create only when nothing matches. Called on
   * every start in webhook mode, so a create-blindly implementation would pile
   * up duplicate registrations and deliver every message several times.
   */
  ensureWebhook(opts: EnsureWebhookOptions): Promise<WebhookRegistration>;

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
