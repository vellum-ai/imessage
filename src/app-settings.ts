/**
 * The plugin config as the configuration app sees it.
 *
 * The app shows the resolved config and lets a few fields be edited. Values
 * live in the host-owned plugin `config.json` — the same file the `init` hook
 * reads via `InitContext.config` — and an edit merges into that file so
 * unrelated fields are preserved.
 *
 * `provider` is deliberately not part of the settings PATCH. Switching
 * providers tears down and restarts the ingress, which is more than a config
 * write, so it goes through its own route.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

import { z } from "zod";

import type { IMessageConfig } from "./config.ts";
import { IMessageConfigSchema, INGRESS_MODES } from "./config.ts";
import { PROVIDER_IDS } from "./providers/types.ts";

/** The resolved config the app displays. No secrets live in it. */
export type ConfigView = IMessageConfig;

/**
 * Partial update accepted by the settings PATCH route.
 *
 * `.strict()` so an unknown or non-editable key is a 400 rather than a silent
 * no-op — a user who edits `provider` here should be told to use the provider
 * route, not left wondering why nothing changed.
 */
export const ConfigUpdateSchema = z
  .object({
    ingressMode: z.enum(INGRESS_MODES).optional(),
    pollIntervalMs: z.number().int().optional(),
    sendChannel: z.enum(["sms", "imessage"]).optional(),
    allowedHandles: z.array(z.string()).optional(),
  })
  .strict();

export type ConfigUpdate = z.infer<typeof ConfigUpdateSchema>;

/** Config keys the app renders as editable, in display order. */
export const EDITABLE_CONFIG_KEYS = [
  "ingressMode",
  "pollIntervalMs",
  "sendChannel",
  "allowedHandles",
] as const;

/** Body accepted by the dedicated provider-change route. */
export const ProviderChangeSchema = z
  .object({ provider: z.enum(PROVIDER_IDS) })
  .strict();

export type ProviderChange = z.infer<typeof ProviderChangeSchema>;

/**
 * Parse `config.json` into a plain object.
 *
 * Returns `{}` when the file is missing or unparsable, so a fresh install
 * reads as all-defaults and a write starts from an empty object rather than
 * crashing.
 */
function readConfigObject(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to empty.
  }
  return {};
}

/** Resolve `config.json` through the schema so defaults are filled in. */
export function readConfigView(configPath: string): ConfigView {
  const parsed = IMessageConfigSchema.safeParse(readConfigObject(configPath));
  return parsed.success ? parsed.data : IMessageConfigSchema.parse({});
}

/**
 * Merge a partial update into `config.json` and persist it.
 *
 * Merging rather than replacing keeps fields the app does not surface. The
 * write is atomic (temp file plus rename) so a crash mid-write cannot leave a
 * truncated config that reads back as all-defaults.
 *
 * Throws when the merged result fails validation, so an out-of-range interval
 * is rejected before it is written rather than silently reset on next boot.
 */
export function applyConfigUpdate(
  configPath: string,
  update: ConfigUpdate,
): ConfigView {
  const merged = { ...readConfigObject(configPath), ...update };

  const parsed = IMessageConfigSchema.safeParse(merged);
  if (!parsed.success) {
    throw new ConfigValidationError(
      parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; "),
    );
  }

  writeConfigObject(configPath, merged);
  return parsed.data;
}

/**
 * Persist a provider change and return the new view.
 *
 * Only writes the config. Restarting the ingress is the caller's job, because
 * the runtime is not reachable from a pure settings module.
 */
export function applyProviderChange(
  configPath: string,
  change: ProviderChange,
): ConfigView {
  const merged = { ...readConfigObject(configPath), provider: change.provider };
  writeConfigObject(configPath, merged);
  return IMessageConfigSchema.parse(merged);
}

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

function writeConfigObject(
  configPath: string,
  value: Record<string, unknown>,
): void {
  const tmp = `${configPath}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  renameSync(tmp, configPath);
}
