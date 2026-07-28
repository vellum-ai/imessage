/**
 * Plugin configuration — schema, defaults, and resolution.
 *
 * The host hands the plugin its parsed config as `InitContext.config` (an
 * `unknown`). This module owns the single Zod schema that validates it.
 *
 * The Comms API key is deliberately not a config field, and the credential's
 * name is not configurable: the plugin always resolves it from a single fixed
 * credential (`imessage:api_key`) so the secret lives in the credential store
 * rather than as plaintext in `config.json`. The `imessage-setup` skill guides
 * the user through storing it.
 */

import { resolveCredential } from "@vellumai/plugin-api";
import { z } from "zod";

/** Comms Messages API base. */
export const COMMS_API_BASE = "https://osis.co/api/v1/comms";

/**
 * Fixed credentials the plugin reads its secrets from.
 *
 * `resolveCredential` takes a `"service/field"` ref; the colon form
 * (`imessage:api_key`) is the human-facing name used by the `assistant
 * credentials` CLI and in error messages. Keep the two spellings straight —
 * passing the colon form to `resolveCredential` does not resolve.
 */
export const CREDENTIAL_SERVICE = "imessage";
export const API_KEY_FIELD = "api_key";
export const WEBHOOK_SECRET_FIELD = "webhook_secret";

/**
 * How inbound messages reach the plugin.
 *
 * `poll` is the default because it is the only mode built entirely on
 * documented behavior: `GET /messages` with a `since` bound, needing just the
 * `comms_read` scope and no public surface. The webhook mode is faster but its
 * payload envelope and signature scheme are not in the published docs, so it
 * stays opt-in until verified against a real delivery.
 */
export const INGRESS_MODES = ["poll", "webhook"] as const;
export type IngressMode = (typeof INGRESS_MODES)[number];

/** Bounds on the poll interval. Comms rate-limits with 429. */
const MIN_POLL_INTERVAL_MS = 2_000;
const MAX_POLL_INTERVAL_MS = 300_000;

export const IMessageConfigSchema = z.object({
  ingressMode: z
    .enum(INGRESS_MODES)
    .default("poll")
    .describe(
      "How inbound messages arrive: 'poll' the Messages API (default), or receive 'webhook' deliveries.",
    ),
  pollIntervalMs: z
    .number()
    .int()
    .min(MIN_POLL_INTERVAL_MS)
    .max(MAX_POLL_INTERVAL_MS)
    .default(5_000)
    .describe("Delay between polls of the Messages API, in milliseconds."),
  /**
   * Preferred send channel. `undefined` lets Comms choose, which is the
   * documented default and the right answer for most lines: it uses iMessage
   * where the handle supports it and falls back to SMS.
   */
  sendChannel: z
    .enum(["sms", "imessage"])
    .optional()
    .describe(
      "Force a delivery channel for outbound messages. Omit to let Comms choose.",
    ),
  /**
   * Handles allowed to reach the assistant. Empty means no plugin-side filter
   * — the gateway's admission floor is still the real gate, this is a coarse
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
 * Unknown keys are dropped with a warning rather than rejected, so a config
 * written for a newer version of the plugin still boots.
 */
export function resolveConfig(raw: unknown): ResolvedConfig {
  const warnings: string[] = [];
  const parsed = IMessageConfigSchema.safeParse(raw ?? {});

  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      warnings.push(`${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
    // Fall back to defaults rather than throwing: a bad interval should not
    // stop the channel from loading.
    warnings.push("falling back to default configuration");
    return { config: IMessageConfigSchema.parse({}), warnings };
  }

  if (parsed.data.ingressMode === "webhook") {
    warnings.push(
      "ingressMode 'webhook' is unverified: the Comms webhook envelope and signature scheme are not in the published docs. Confirm against a real delivery before relying on it.",
    );
  }

  return { config: parsed.data, warnings };
}

/**
 * Read the Comms API key from the credential store.
 *
 * Resolved at call time rather than cached at init so a rotated key takes
 * effect without a daemon restart.
 *
 * `resolveCredential` throws when the reference does not resolve; that is
 * rewritten here into an error naming the command that fixes it, because the
 * common case is a user who has installed the plugin but not run setup yet.
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
 * Read the webhook signing secret, or `undefined` when none is stored.
 *
 * Absence is a normal state, not an error — the default poll mode never needs
 * one. Returning `undefined` rather than throwing is what lets the webhook
 * route answer a clean 401 instead of a 500.
 */
export async function resolveWebhookSecret(): Promise<string | undefined> {
  try {
    return (
      (await resolveCredential(
        `${CREDENTIAL_SERVICE}/${WEBHOOK_SECRET_FIELD}`,
      )) || undefined
    );
  } catch {
    return undefined;
  }
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
