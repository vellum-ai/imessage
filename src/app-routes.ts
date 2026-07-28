/**
 * Request handlers backing the plugin's HTTP routes (`routes/*.ts`).
 *
 * The route files are thin wrappers that call these. Each handler resolves the
 * plugin's own paths internally, so callers never pass a directory in.
 */

import {
  applyConfigUpdate,
  applyProviderChange,
  ConfigUpdateSchema,
  ConfigValidationError,
  EDITABLE_CONFIG_KEYS,
  ProviderChangeSchema,
  readConfigView,
} from "./app-settings.ts";
import { startChannelRuntime } from "./channel-runtime.ts";
import { getProvider } from "./plugin-state.ts";
import { pluginConfigPath } from "./plugin-paths.ts";
import { PROVIDER_IDS } from "./providers/types.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * `GET /x/plugins/imessage/settings`: the resolved config plus what the app
 * needs to render its controls.
 *
 * `activeProvider` is the provider actually running, which can differ from the
 * configured one when the configured provider failed to build. Reporting both
 * is what lets the app show "configured as vellum, currently idle" instead of
 * claiming everything is fine.
 */
export async function handleSettingsGet(): Promise<Response> {
  const config = readConfigView(pluginConfigPath());
  return json({
    config,
    editableKeys: EDITABLE_CONFIG_KEYS,
    providers: PROVIDER_IDS,
    activeProvider: getProvider()?.id ?? null,
  });
}

/** `PATCH /x/plugins/imessage/settings`: apply a partial update. */
export async function handleSettingsPatch(
  request: Request,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  const parsed = ConfigUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return json(
      {
        error: "invalid settings update",
        detail: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
      400,
    );
  }

  let config;
  try {
    config = applyConfigUpdate(pluginConfigPath(), parsed.data);
  } catch (err) {
    if (err instanceof ConfigValidationError) {
      return json({ error: err.message }, 400);
    }
    throw err;
  }

  // Ingress settings change how inbound is received, so the runtime is
  // restarted rather than left on the previous configuration until a reboot.
  const result = startChannelRuntime(config);

  return json({ config, idleReason: result.idleReason ?? null });
}

/**
 * `POST /x/plugins/imessage/provider`: switch providers.
 *
 * Deliberately separate from the settings PATCH: after the config write the
 * old ingress is torn down and the new provider's is started immediately.
 * Posting the active provider bounces it, which is a useful way to recover a
 * wedged worker without restarting the daemon.
 */
export async function handleProviderPost(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  const parsed = ProviderChangeSchema.safeParse(body);
  if (!parsed.success) {
    return json(
      { error: `provider must be one of: ${PROVIDER_IDS.join(", ")}` },
      400,
    );
  }

  const config = applyProviderChange(pluginConfigPath(), parsed.data);
  const result = startChannelRuntime(config);

  return json({
    config,
    activeProvider: getProvider()?.id ?? null,
    idleReason: result.idleReason ?? null,
  });
}
