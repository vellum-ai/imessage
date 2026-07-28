/**
 * Plugin configuration — schema, defaults, and credential resolution.
 *
 * The host hands the plugin its parsed config as `InitContext.config` (an
 * `unknown`). This module owns the single Zod schema that validates it.
 *
 * The Comms API key is deliberately not a config field, and the credential's
 * name is not configurable: the BYOK provider always resolves it from a single
 * fixed credential so the secret lives in the credential store rather than as
 * plaintext in `config.json`.
 */

import { resolveCredential } from "@vellumai/plugin-api";
import { z } from "zod";

import { PROVIDER_IDS } from "./providers/types.ts";

/**
 * Fixed credential the BYOK provider reads its key from.
 *
 * `resolveCredential` takes a `"service/field"` ref; the colon form
 * (`imessage:api_key`) is the human-facing name used by the `assistant
 * credentials` CLI and in error messages. Keep the two spellings straight —
 * passing the colon form to `resolveCredential` does not resolve.
 */
export const CREDENTIAL_SERVICE = "imessage";
export const API_KEY_FIELD = "api_key";

/**
 * How inbound messages reach the plugin.
 *
 * `webhook` is the default: the provider pushes, so a message becomes a turn
 * within a second rather than within a poll interval, and nothing burns
 * requests while a line is quiet. Signature verification belongs to the
 * gateway, so the route only ever sees deliveries the gateway already
 * authenticated.
 *
 * `poll` exists for BYOK deployments whose gateway is not reachable from the
 * internet. It only works on providers that support it.
 */
export const INGRESS_MODES = ["webhook", "poll"] as const;
export type IngressMode = (typeof INGRESS_MODES)[number];

/** Bounds on the poll interval. Comms rate-limits with 429. */
const MIN_POLL_INTERVAL_MS = 2_000;
const MAX_POLL_INTERVAL_MS = 300_000;

export const IMessageConfigSchema = z.object({
  provider: z
    .enum(PROVIDER_IDS)
    .default("vellum")
    .describe(
      "Who owns the line: 'vellum' (the platform provisions it, default) or 'comms' (your own Comms by Osis account).",
    ),
  ingressMode: z
    .enum(INGRESS_MODES)
    .default("webhook")
    .describe(
      "How inbound messages arrive: 'webhook' (default) or 'poll' for deployments with no public ingress.",
    ),
  pollIntervalMs: z
    .number()
    .int()
    .min(MIN_POLL_INTERVAL_MS)
    .max(MAX_POLL_INTERVAL_MS)
    .default(5_000)
    .describe("Delay between polls, in milliseconds. Only used in poll mode."),
  /**
   * Preferred send channel for the BYOK provider. `undefined` lets Comms
   * choose, which is the documented default and right for most lines: it uses
   * iMessage where the handle supports it and falls back to SMS.
   */
  sendChannel: z
    .enum(["sms", "imessage"])
    .optional()
    .describe(
      "Force a delivery channel for outbound messages. Omit to let the provider choose.",
    ),
  /**
   * Handles allowed to reach the assistant. Empty means no plugin-side filter
   * — the gateway's admission floor is the real gate, this is a coarse
   * pre-filter for a line that is also used for something else.
   */
  allowedHandles: z
    .array(z.string())
    .default([])
    .describe(
      "E.164 handles allowed to reach the assistant. Empty allows all; the admission floor still applies.",
    ),
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
 * Read the Comms API key from the credential store.
 *
 * Resolved at call time rather than at load, so a rotated key takes effect
 * without a daemon restart and an unconfigured BYOK line fails only when it is
 * actually used.
 *
 * `resolveCredential` throws when the reference does not resolve; that is
 * rewritten here into an error naming the command that fixes it.
 */
export async function resolveApiKey(): Promise<string> {
  try {
    const key = await resolveCredential(
      `${CREDENTIAL_SERVICE}/${API_KEY_FIELD}`,
    );
    if (key) return key;
  } catch {
    // Fall through to the actionable message below.
  }
  throw new Error(
    `Comms API key not found. The credential "${CREDENTIAL_SERVICE}:${API_KEY_FIELD}" must be stored in the credential store. ` +
      `Run: assistant credentials set --service ${CREDENTIAL_SERVICE} --field ${API_KEY_FIELD} <your_key>`,
  );
}

/**
 * Whether a handle passes the plugin-side allowlist.
 *
 * An empty allowlist admits everything. This is a pre-filter, not a security
 * boundary — the gateway's admission floor is.
 */
export function isAllowedHandle(
  config: IMessageConfig,
  handle: string,
): boolean {
  if (config.allowedHandles.length === 0) return true;
  return config.allowedHandles.includes(handle);
}
