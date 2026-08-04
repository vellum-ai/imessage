/**
 * The public URL a provider should deliver webhooks to.
 *
 * **One route per provider**, not one shared route: `events-photon` and
 * `events-comms`. Which provider signed a delivery decides how it must be
 * verified, and the gateway only reads its own static manifest — so the
 * provider has to be identifiable from the path rather than from this plugin's
 * config. Encoding it in the URL is what keeps the gateway's side static while
 * this plugin's choice of provider stays dynamic.
 *
 * The prefix and the plugin name are the gateway's, composed from the
 * directory this plugin is installed in, so the path is derived here rather
 * than configured.
 *
 * The base is the assistant's own `ingress.publicBaseUrl`, read from the
 * workspace config. There is no plugin-API accessor for it, and it is not
 * something this plugin should carry its own copy of: a second setting that
 * has to agree with the assistant's is a second setting that can disagree.
 *
 * It is legitimately empty on a deployment fronted by a Velay tunnel, where
 * the public URL is the tunnel's and lives in gateway state rather than
 * config. That case reports a reason instead of guessing a URL — registering a
 * wrong one is worse than registering none, because the provider then reports
 * a healthy webhook that points nowhere.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { getWorkspaceDir } from "@vellumai/plugin-api";

import { CHANNEL_ID } from "./plugin-paths.ts";
import type { ProviderId } from "./providers/types.ts";

/**
 * Route path for a provider, as declared in `channels/ingress.json`.
 *
 * Flat rather than nested (`events-photon`, not `events/photon`) so the path,
 * the handler filename, and the declaration are all one segment — the gateway
 * matches declared paths exactly, and a nested path is three places for a
 * separator to disagree.
 */
export function ingressRoutePath(provider: ProviderId): string {
  return `events-${provider}`;
}

/**
 * Query parameter carrying the shared secret on providers that do not sign.
 *
 * Comms documents no signature scheme and returns no signing secret, so the
 * only thing that can prove a delivery came from the line we registered is a
 * token we minted and put in the URL. The gateway compares it in constant
 * time; `channels/ingress.json` names both the parameter and the credential.
 */
export const SHARED_SECRET_PARAM = "token";

export type WebhookEndpoint =
  | { ok: true; url: string }
  | { ok: false; reason: string };

export interface WebhookEndpointOptions {
  /** Provider the route is for. Becomes the last path segment. */
  provider: ProviderId;
  /**
   * Shared secret to carry in the query, for a provider that cannot sign.
   * Omitted for providers whose deliveries are verified by signature.
   */
  sharedSecret?: string;
}

/** `<workspaceDir>/config.json`, the assistant's own config. */
function readWorkspaceConfig(): Record<string, unknown> {
  try {
    const path = join(getWorkspaceDir(), "config.json");
    if (!existsSync(path)) return {};
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // An unreadable config reads as "not configured", which is the same
    // answer as an absent one and needs no separate handling.
  }
  return {};
}

/** The absolute URL a provider posts deliveries to, or why there is not one. */
export function resolveWebhookEndpoint(
  opts: WebhookEndpointOptions,
): WebhookEndpoint {
  const ingress = readWorkspaceConfig().ingress;
  const base =
    ingress && typeof ingress === "object"
      ? (ingress as { publicBaseUrl?: unknown }).publicBaseUrl
      : undefined;

  if (typeof base !== "string" || base.trim().length === 0) {
    return {
      ok: false,
      reason:
        "the assistant has no ingress.publicBaseUrl configured, so there is no address to register",
    };
  }

  const url = new URL(
    `${base.trim().replace(/\/+$/, "")}/webhooks/plugins/${CHANNEL_ID}/${ingressRoutePath(opts.provider)}`,
  );
  if (opts.sharedSecret) {
    url.searchParams.set(SHARED_SECRET_PARAM, opts.sharedSecret);
  }

  return { ok: true, url: url.toString() };
}
