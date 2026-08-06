/**
 * The public URL a provider should deliver webhooks to.
 *
 * **One route per provider**, not one shared route: `events-photon` and
 * `events-comms`. Which provider signed a delivery decides how it must be
 * verified, and the gateway only reads its own static manifest — so the
 * provider has to be identifiable from the path rather than from this plugin's
 * config.
 *
 * **The base is the host's to decide, not this plugin's.** Composing one from
 * `ingress.publicBaseUrl` is the obvious move and it is wrong in the case that
 * matters: on a platform-connected assistant that value holds the Velay tunnel
 * URL, so a webhook registered against it looks healthy while every delivery
 * goes somewhere the gateway is not serving. That is exactly what this plugin
 * did, and the symptom was a registration nobody could fault and inbound that
 * never arrived.
 *
 * `resolvePluginWebhookUrl` in `@vellumai/plugin-api` answers it properly —
 * platform pods first, then a configured public ingress, then a managed
 * callback route for a platform-connected assistant — and registers the
 * callback route on the managed branches. It is the same order `webhooks
 * register` uses, which is the point: a plugin that derived its own copy would
 * keep whichever version it was written against.
 *
 * The config fallback below stays for a host that predates that export. It has
 * the old flaw, so it says so in the reason rather than reporting a healthy
 * registration.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import * as pluginApi from "@vellumai/plugin-api";
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

export type WebhookEndpoint =
  | { ok: true; url: string }
  | { ok: false; reason: string };

/**
 * The host's resolver, when it has one.
 *
 * Looked up off the namespace rather than imported by name so the plugin still
 * loads against a host that predates it — the installed type definitions are a
 * released package, and this export lands before that package is republished.
 */
export type WebhookUrlResolver = (opts: {
  plugin: string;
  path: string;
  sourceIdentifier?: string;
}) => Promise<string>;

function hostResolver(): WebhookUrlResolver | undefined {
  const candidate = (pluginApi as Record<string, unknown>)
    .resolvePluginWebhookUrl;
  return typeof candidate === "function"
    ? (candidate as WebhookUrlResolver)
    : undefined;
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

/**
 * What this plugin can work out on its own, for a host with no resolver.
 *
 * Deliberately not the primary path. It cannot tell a self-hosted tunnel from
 * a Velay one, so on a platform-connected assistant it produces a URL that is
 * reachable and wrong.
 */
function endpointFromConfig(provider: ProviderId): WebhookEndpoint {
  const ingress = readWorkspaceConfig().ingress;
  const base =
    ingress && typeof ingress === "object"
      ? (ingress as { publicBaseUrl?: unknown }).publicBaseUrl
      : undefined;

  if (typeof base !== "string" || base.trim().length === 0) {
    return {
      ok: false,
      reason:
        "this assistant has no webhook URL resolver and no ingress.publicBaseUrl, so there is no address to register",
    };
  }

  return {
    ok: true,
    url: `${base.trim().replace(/\/+$/, "")}/webhooks/plugins/${CHANNEL_ID}/${ingressRoutePath(provider)}`,
  };
}

/**
 * The absolute URL a provider posts deliveries to, or why there is not one.
 *
 * `resolver` is a test seam. The real one comes off the plugin-api namespace,
 * which a test cannot swap after this module has imported it.
 */
export async function resolveWebhookEndpoint(
  provider: ProviderId,
  resolver?: WebhookUrlResolver,
): Promise<WebhookEndpoint> {
  const resolve = resolver ?? hostResolver();
  if (!resolve) {
    return endpointFromConfig(provider);
  }

  try {
    const url = await resolve({
      plugin: CHANNEL_ID,
      path: ingressRoutePath(provider),
      sourceIdentifier: `iMessage (${provider})`,
    });
    return { ok: true, url };
  } catch (err) {
    // No ingress and no platform connection is a real answer, not a failure
    // to handle: there is no URL that would work, and registering a plausible
    // one would leave the provider reporting a healthy webhook that points
    // nowhere.
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
