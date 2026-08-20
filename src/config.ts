/**
 * Plugin configuration — schema, defaults, and credential resolution.
 *
 * The host hands the plugin its parsed config as `InitContext.config` (an
 * `unknown`). This module owns the single Zod schema that validates it.
 *
 * No secret is a config field, and no credential name is configurable: each
 * provider resolves from the fixed set of fields declared in
 * `PROVIDER_CREDENTIALS`, so secrets live in the credential store rather than
 * as plaintext in `config.json`.
 */

import { resolveCredential } from "@vellumai/plugin-api";
import { z } from "zod";

import { describeError } from "./providers/error-detail.ts";
import type { ProviderId } from "./providers/types.ts";
import { PROVIDER_IDS } from "./providers/types.ts";

/**
 * Fixed credential service the providers read their secrets from.
 *
 * `resolveCredential` takes a `"service/field"` ref; the colon form
 * (`imessage:api_key`) is the human-facing name used by the `assistant
 * credentials` CLI and in error messages. Keep the two spellings straight —
 * passing the colon form to `resolveCredential` does not resolve.
 */
export const CREDENTIAL_SERVICE = "imessage";
export const API_KEY_FIELD = "api_key";

/**
 * One credential a provider needs, as the settings app renders it.
 *
 * Field identity only — what it is called and how to draw its input. The
 * prose around it (what the provider is, where to get a key) is display copy
 * and lives in the app's provider catalog, mirroring how the assistant's own
 * provider forms split the two.
 *
 * `secret: false` is not decoration. A Photon project id is an identifier that
 * appears in its own dashboard URL, and masking it means a user cannot check
 * the value they just pasted against the one on screen. Masking exists for the
 * value that would compromise the account, not for every field next to it.
 */
export interface CredentialField {
  /** Field name within the `imessage` credential service. */
  field: string;
  label: string;
  /** Shown in the empty input. Replaced by a masked hint once a value exists. */
  placeholder: string;
  secret: boolean;
}

/**
 * What each provider needs stored before it can do anything.
 *
 * The settings app reads this to render its fields, and `checkReadiness` on
 * each adapter resolves exactly these. One list, so a provider cannot ask for
 * a credential the app never offers to collect.
 */
export const PROVIDER_CREDENTIALS: Record<
  ProviderId,
  readonly CredentialField[]
> = {
  photon: [
    {
      field: "photon_project_id",
      label: "Project ID",
      placeholder: "Enter your Photon project ID",
      secret: false,
    },
    {
      field: "photon_project_secret",
      label: "Project Secret",
      placeholder: "Enter your Photon project secret",
      secret: true,
    },
  ],
  comms: [
    {
      field: API_KEY_FIELD,
      label: "API Key",
      placeholder: "Enter your Comms API key",
      secret: true,
    },
  ],
};

/**
 * Where each provider's inbound-webhook secret is stored.
 *
 * Not in `PROVIDER_CREDENTIALS`: nobody types these. Both providers issue one
 * during webhook registration, so the settings app must not offer a field for
 * a value the user has no way to know.
 *
 * The gateway reads the same credential when it verifies a delivery — the
 * route's `verification.secret.field` in `channels/ingress.json` names exactly
 * these. Renaming one here without renaming it there silently stops every
 * delivery from verifying.
 */
export const WEBHOOK_SECRET_FIELDS: Record<ProviderId, string> = {
  photon: "photon_webhook_secret",
  comms: "comms_webhook_secret",
};

/**
 * How inbound messages reach the plugin.
 *
 * `live` is the default on Photon: it holds the provider's long-lived gRPC
 * connection (the same channel send already uses) and reads inbound off it.
 * That needs no public URL and no webhook secret. Comms has no such plane, so
 * a Comms config that names `live` is read as `webhook`.
 *
 * `webhook` is the provider pushing over HTTP. Signature verification belongs
 * to the gateway, so the route only ever sees deliveries the gateway already
 * authenticated.
 *
 * `poll` exists for deployments whose gateway is not reachable from the
 * internet and whose provider has no live stream. It only works on providers
 * that support it.
 */
export const INGRESS_MODES = ["webhook", "poll", "live"] as const;
export type IngressMode = (typeof INGRESS_MODES)[number];

/** Bounds on the poll interval. Comms rate-limits with 429. */
const MIN_POLL_INTERVAL_MS = 2_000;
const MAX_POLL_INTERVAL_MS = 300_000;

export const IMessageConfigSchema = z
  .object({
    provider: z
      .enum(PROVIDER_IDS)
      .default("photon")
      .describe(
        "Which provider backs the line: 'photon' (your own Photon project, the default) or 'comms' (your own Comms by Osis account).",
      ),
    ingressMode: z
      .enum(INGRESS_MODES)
      .default("live")
      .describe(
        "How inbound messages arrive: 'live' (Photon's gRPC stream, the default), 'webhook', or 'poll' for deployments with no public ingress.",
      ),
    pollIntervalMs: z
      .number()
      .int()
      .min(MIN_POLL_INTERVAL_MS)
      .max(MAX_POLL_INTERVAL_MS)
      .default(5_000)
      .describe("Delay between polls, in milliseconds. Only used in poll mode."),
  })
  .transform((config) => {
    if (config.provider === "comms" && config.ingressMode === "live") {
      return { ...config, ingressMode: "webhook" as const };
    }
    return config;
  });

export type IMessageConfig = z.infer<typeof IMessageConfigSchema>;

export interface ResolvedConfig {
  config: IMessageConfig;
  warnings: string[];
}

/**
 * Validate the host-supplied config.
 *
 * Invalid values fall back to defaults with a warning rather than throwing: a
 * bad interval should not stop the channel from loading.
 */
export function resolveConfig(raw: unknown): ResolvedConfig {
  const warnings: string[] = [];
  const parsed = IMessageConfigSchema.safeParse(raw ?? {});

  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      warnings.push(`${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
    warnings.push("falling back to default configuration");
    return { config: IMessageConfigSchema.parse({}), warnings };
  }

  return { config: parsed.data, warnings };
}

/**
 * Read one stored credential field.
 *
 * Resolved at call time rather than at load, so a rotated key takes effect
 * without a daemon restart and an unconfigured line fails only when it is
 * actually used.
 *
 * `resolveCredential` throws when the reference does not resolve. That error
 * covers a missing value, an unreachable store, and a scoping refusal with
 * one type, so this message does not guess which it was. The store's own
 * words lead, because a guessed "not set" is the diagnosis that sends someone
 * to re-enter a key that is already there. An empty value is the one case
 * this path can name as unset.
 */
export async function resolveCredentialField(
  field: string,
  label: string,
): Promise<string> {
  let value: string | undefined;
  try {
    value = await resolveCredential(`${CREDENTIAL_SERVICE}/${field}`);
  } catch (err) {
    throw new Error(`${label} could not be read: ${describeError(err)}`, {
      cause: err,
    });
  }

  if (value) {
    return value;
  }

  throw new Error(
    `${label} is not set. Add it in the iMessage settings app.`,
  );
}

/** Read the Comms API key. */
export async function resolveApiKey(): Promise<string> {
  return resolveCredentialField(API_KEY_FIELD, "The Comms API key");
}
