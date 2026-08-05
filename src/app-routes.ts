/**
 * Request handlers backing the plugin's HTTP routes (`routes/*.ts`).
 *
 * The route files are thin wrappers that call these. Each handler resolves the
 * plugin's own paths internally, so callers never pass a directory in.
 */

import {
  CredentialWriteError,
  readCredentialStatus,
  storeCredentials,
} from "./app-credentials.ts";
import {
  applyConfigUpdate,
  applyProviderChange,
  ConfigUpdateSchema,
  ConfigValidationError,
  CredentialUpdateSchema,
  ProviderChangeSchema,
  readConfigView,
} from "./app-settings.ts";
import { startChannelRuntime } from "./channel-runtime.ts";
import { INGRESS_MODES } from "./config.ts";
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
 * is what lets the app show "configured as photon, currently idle" instead of
 * claiming everything is fine.
 *
 * `credentials` rides along rather than sitting behind its own GET: the app
 * needs it to draw the very first frame, and a second round trip would only
 * buy a moment of rendering fields whose state is unknown.
 *
 * `providers` and `ingressModes` are what the plugin actually supports; the
 * app holds only the copy describing them, and renders the intersection. That
 * is the same split the provider dropdown already used, extended to ingress so
 * a mode removed here disappears from the panel rather than lingering as an
 * option that fails validation on save.
 *
 * What is deliberately not sent is a list of *editable keys*. Which controls
 * exist is the app's own decision, and naming them here was a second place for
 * that to be stated and to be wrong — `sendChannel` sat in that list long after
 * it stopped meaning anything on the default provider.
 */
export async function handleSettingsGet(): Promise<Response> {
  const config = readConfigView(pluginConfigPath());
  return json({
    config,
    providers: PROVIDER_IDS,
    ingressModes: INGRESS_MODES,
    activeProvider: getProvider()?.id ?? null,
    credentials: await readCredentialStatus(),
  });
}

/**
 * `POST /x/plugins/imessage/credentials`: store a provider's credentials.
 *
 * Answers with the refreshed status rather than an acknowledgement, so the app
 * renders what the store actually holds instead of assuming the write landed.
 *
 * Storing credentials for the *configured* provider also restarts ingress. A
 * channel that is idle for want of an API key should come up the moment the
 * key arrives, and telling someone to go click the provider button afterwards
 * is a step that only exists because the code did not do it.
 */
export async function handleCredentialsPost(
  request: Request,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  const parsed = CredentialUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return json(
      {
        error: "invalid credential update",
        detail: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
      400,
    );
  }

  try {
    await storeCredentials(parsed.data.provider, parsed.data.values);
  } catch (err) {
    if (err instanceof CredentialWriteError) {
      return json({ error: err.message }, 400);
    }
    throw err;
  }

  const config = readConfigView(pluginConfigPath());
  const result =
    config.provider === parsed.data.provider
      ? startChannelRuntime(config)
      : undefined;

  return json({
    credentials: await readCredentialStatus(),
    status: result?.status ?? null,
    idleReason: result?.idleReason ?? null,
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

  return json({
    config,
    status: result.status,
    idleReason: result.idleReason ?? null,
  });
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
    status: result.status,
    idleReason: result.idleReason ?? null,
    credentials: await readCredentialStatus(),
  });
}
