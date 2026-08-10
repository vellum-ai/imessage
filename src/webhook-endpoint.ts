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
 * `resolveWebhookUrl` in `@vellumai/plugin-api` answers it properly —
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
    .resolveWebhookUrl;
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
 * Drop a trailing slash the host may have handed back.
 *
 * The platform's callback registration appends one, and a provider delivers to
 * the URL it was given verbatim — `events-comms/`, which the gateway matches
 * against the declared `events-comms`. Newer hosts trim it themselves; this
 * keeps a registration correct against one that does not, since the URL is
 * stored on the provider's side and outlives the host version that produced it.
 */
function withoutTrailingSlash(url: string): string {
  if (url.includes("?") || url.includes("#")) return url;
  return url.replace(/\/+$/, "");
}

/**
 * Whether two webhook URLs name the same registration.
 *
 * They do when they differ only by a trailing slash, because the gateway
 * serves both spellings of a declared route — matching ignores one trailing
 * slash (`findDeclaredRoute`) — so a provider pointed at either delivers to
 * the same place.
 *
 * This exists because comparing with `===` had a consequence far worse than a
 * cosmetic mismatch. `ensureWebhook` lists first and creates only when nothing
 * matches, so a registration stored as `events-comms/` did not match the
 * `events-comms` we now ask for, and the next start created a *second*
 * registration next to it. Both then delivered, each signed with its own
 * secret, and the plugin held only the newer one — so every other delivery
 * failed signature verification with a 403 that looked like it depended on
 * which spelling of the URL you had used.
 *
 * Only the trailing slash is forgiven. Everything else — scheme, host, port,
 * case, query — is compared verbatim, because any other difference really is a
 * different address and matching on it would leave a stale registration
 * delivering to somewhere the gateway is not serving.
 */
export function sameWebhookUrl(a: string, b: string): boolean {
  return withoutTrailingSlash(a.trim()) === withoutTrailingSlash(b.trim());
}

/**
 * The registration to use for `url`, out of everything the provider lists.
 *
 * Matching by {@link sameWebhookUrl} can find more than one, on a deployment
 * that already grew a duplicate before the comparison was fixed. Which one is
 * picked decides which secret this plugin holds, and therefore which of the
 * two live registrations verifies — so it is decided here rather than left to
 * whatever order the provider happened to list them in.
 *
 * An exact match wins. The plugin always asks for the canonical spelling, so
 * preferring it means a deployment converges on the registration the plugin
 * itself created rather than oscillating between them across restarts.
 * Cleaning up the leftover is still a manual step in the provider's dashboard;
 * neither vendor's listing tells us which of two registrations is the one
 * someone meant to keep.
 */
export function pickWebhookRegistration<T>(
  candidates: readonly T[],
  url: string,
  urlOf: (candidate: T) => string | undefined,
): T | undefined {
  const matches = candidates.filter((candidate) => {
    const found = urlOf(candidate);
    return found !== undefined && sameWebhookUrl(found, url);
  });
  return matches.find((candidate) => urlOf(candidate)?.trim() === url.trim()) ?? matches[0];
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
    return { ok: true, url: withoutTrailingSlash(url) };
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
