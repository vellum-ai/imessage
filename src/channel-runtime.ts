/**
 * Channel runtime — building the provider and running the ingress for it.
 *
 * Shared by `init` and by the provider route, so switching providers from the
 * configuration app runs exactly the same code path as a fresh boot. That is
 * the whole reason this is not inlined into the hook: a switch that only
 * half-matched boot would drift, and the drift would show as "it works after a
 * restart".
 *
 * Every entry point is safe to call repeatedly: `start` tears down whatever is
 * running first.
 */

import { readSecret, storeSecret } from "./app-credentials.ts";
import { buildChannelProvider } from "./channel/provider.ts";
import type { IMessageConfig } from "./config.ts";
import { WEBHOOK_SECRET_FIELDS } from "./config.ts";
import type { RuntimeContext } from "./plugin-state.ts";
import {
  getInitContext,
  getProvider,
  getSupervisor,
  setChannel,
  setConfig,
  setProvider,
  setSupervisor,
} from "./plugin-state.ts";
import { pluginDataDir, pluginName } from "./plugin-paths.ts";
import { resolveProvider } from "./providers/index.ts";
import type { MessagingProvider } from "./providers/types.ts";
import { resolveWebhookEndpoint } from "./webhook-endpoint.ts";
import { PollWorkerSupervisor } from "./worker/supervisor.ts";

/**
 * What happened to the channel.
 *
 * - `running` — ingress is up on the configured provider.
 * - `idle` — the provider was built here and could not come up; `idleReason`
 *   says why, and it is something the user can act on.
 *
 * There is deliberately no third state for "this caller has no runtime". A
 * save arriving before `init` used to report one, which said the write applied
 * on the next reload — true, and mostly read as an alarm about a channel
 * nobody had broken. `derivedContext` removes the condition instead.
 */
export type ChannelStatus = "running" | "idle";

export interface StartRuntimeResult {
  status: ChannelStatus;
  /** Why the channel is idle. Only set when `status` is `idle`. */
  idleReason?: string;
}

/**
 * Point the provider's webhook at this plugin's ingress route.
 *
 * Runs on every webhook-mode start, which is what makes a credential saved in
 * the settings app enough to finish setup: the restart that follows the save
 * is what registers. `ensureWebhook` lists before it creates, so repeating it
 * costs one request rather than a duplicate registration.
 *
 * Never throws. An unregistered webhook is a channel that hears nothing, not a
 * channel that failed to load, and taking the daemon's boot down over a
 * provider's 500 would be the worse trade.
 */
async function registerWebhook(
  provider: MessagingProvider,
  logger: RuntimeContext["logger"],
): Promise<void> {
  const secretField = WEBHOOK_SECRET_FIELDS[provider.id];

  try {
    const held = await readSecret(secretField);
    const endpoint = resolveWebhookEndpoint(provider.id);
    if (!endpoint.ok) {
      logger.warn(
        { provider: provider.id, reason: endpoint.reason },
        "imessage: no webhook could be registered — inbound will not arrive until ingress.publicBaseUrl is set or ingressMode is 'poll'",
      );
      return;
    }

    const result = await provider.ensureWebhook({
      url: endpoint.url,
      hasSecret: Boolean(held),
    });

    // Store before reporting success: a secret dropped here leaves a
    // registration whose deliveries nothing can verify. Providers hand one
    // back on every registration they can — Photon only when it creates,
    // Comms whenever asked — so this runs whether or not anything was created.
    if (result.secret && result.secret !== held) {
      await storeSecret(secretField, result.secret);
    }

    logger.info(
      { provider: provider.id, created: result.created },
      result.created
        ? "imessage: registered the inbound webhook with the provider"
        : "imessage: provider webhook already registered",
    );
  } catch (err) {
    // Everything is inside the boundary, minting and storing included: this
    // runs un-awaited, so anything escaping is an unhandled rejection rather
    // than a channel that reports what went wrong.
    logger.warn(
      { err, provider: provider.id },
      "imessage: could not register the inbound webhook — the channel is running but will not hear anything",
    );
  }
}

/**
 * Stop whatever ingress is running. Leaves the resolved provider in place so
 * outbound delivery still works while inbound is down.
 */
export function stopIngress(): void {
  getSupervisor()?.stop();
  setSupervisor(undefined);
}

/**
 * Drop the current provider, giving back anything it holds open.
 *
 * Un-awaited on purpose: this runs on the synchronous path that a settings
 * save and a fresh boot share, and neither should wait on a socket closing.
 * The provider is already unreachable by the time the close lands, so a
 * failure has nothing left to affect — hence the swallowed rejection.
 */
export function releaseProvider(): void {
  const previous = getProvider();
  setProvider(undefined);
  void previous?.close?.().catch(() => {});
}

/**
 * A runtime context for a caller the `init` hook has not reached.
 *
 * `init` stashes the host's context, and until now anything running before it
 * — a settings save arriving on a route while the hook has not run, or been
 * torn down and not yet re-run — had nothing to build a channel with and
 * reported `not-loaded`: the config write landed, the channel did not, and the
 * app said so with a line about reloading that mostly read as an alarm.
 *
 * Nothing in that context actually had to come from the host. The plugin's own
 * paths module resolves both fields from this file's location, and for an
 * external plugin the storage directory it derives is the same `<plugin>/data`
 * the host passes in — so a channel built on this one is the same channel,
 * writing the same poll cursor. The logger is the one real loss, and a save
 * that works silently beats a save that narrates why it did not.
 */
function derivedContext(): RuntimeContext {
  return {
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    pluginStorageDir: pluginDataDir(),
    pluginName: pluginName(),
  };
}

/**
 * Build the provider for `config` and start its ingress.
 *
 * Never throws: a provider that cannot be built, or an ingress mode the
 * provider does not support, leaves the channel idle with a reason. Plugin
 * load and a settings edit both need to survive a bad configuration.
 */
export function startChannelRuntime(
  config: IMessageConfig,
): StartRuntimeResult {
  const ctx = getInitContext() ?? derivedContext();

  stopIngress();
  setConfig(config);

  // Clear the previous provider before attempting to build the new one. If the
  // build fails we must not leave the old provider active: outbound would keep
  // going out over a provider the config no longer names, while the settings
  // app reports the new one. Idle is the honest state.
  releaseProvider();
  setChannel(undefined);

  let provider;
  try {
    provider = resolveProvider({ config });
  } catch (err) {
    const idleReason = err instanceof Error ? err.message : String(err);
    ctx.logger.warn(
      { err, provider: config.provider },
      "imessage: could not build the configured provider — the channel is idle",
    );
    return { status: "idle", idleReason };
  }

  setProvider(provider);
  setChannel(buildChannelProvider(provider));

  if (config.ingressMode === "webhook") {
    ctx.logger.info(
      { provider: provider.id },
      `imessage: webhook ingress — inbound arrives at /webhooks/plugins/${ctx.pluginName}/events`,
    );
    // Deliberately not awaited: registration is a network round trip to the
    // provider, and neither plugin boot nor a settings save should block on
    // it. A failure leaves the channel running — outbound still works, and
    // inbound was not going to arrive either way.
    void registerWebhook(provider, ctx.logger);
    return { status: "running" };
  }

  if (!provider.supportsPolling) {
    const idleReason = `provider ${provider.id} is webhook-only but ingressMode is 'poll'`;
    ctx.logger.warn({ provider: provider.id }, `imessage: ${idleReason}`);
    return { status: "idle", idleReason };
  }

  const supervisor = new PollWorkerSupervisor({
    bootstrap: {
      storageDir: ctx.pluginStorageDir,
      intervalMs: config.pollIntervalMs,
      provider: config.provider,
    },
    logger: ctx.logger,
    sink: (event) => {
      // TODO(pluggable-channels): hand the event to the host's inbound
      // pipeline so it runs through the kill switch, trust classification, and
      // the admission floor. Posting straight into a conversation would bypass
      // all three, which is exactly the gap this channel must not open.
      ctx.logger.info(
        {
          actorExternalId: event.actor.actorExternalId,
          conversationExternalId: event.message.conversationExternalId,
          externalMessageId: event.message.externalMessageId,
          chatType: event.source.chatType,
        },
        "imessage: normalized inbound message",
      );
    },
  });

  supervisor.start();
  setSupervisor(supervisor);

  ctx.logger.info(
    { provider: provider.id, intervalMs: config.pollIntervalMs },
    "imessage: poll worker started",
  );
  return { status: "running" };
}
