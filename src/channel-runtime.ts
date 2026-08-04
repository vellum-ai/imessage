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

import { buildChannelProvider } from "./channel/provider.ts";
import type { IMessageConfig } from "./config.ts";
import {
  getInitContext,
  getSupervisor,
  setChannel,
  setConfig,
  setProvider,
  setSupervisor,
} from "./plugin-state.ts";
import { resolveProvider } from "./providers/index.ts";
import { PollWorkerSupervisor } from "./worker/supervisor.ts";

/**
 * What happened to the channel.
 *
 * - `running` — ingress is up on the configured provider.
 * - `idle` — the provider was built here and could not come up; `idleReason`
 *   says why, and it is something the user can act on.
 * - `not-loaded` — this process has no plugin runtime to restart. The config
 *   write still happened and takes effect when the plugin next loads.
 *
 * The third case used to report itself as idle with the reason "plugin is not
 * initialized", which read to a user clicking a provider button as though
 * their channel had just broken. It had not: nothing was running in *this*
 * process to restart. Separating the two is what lets the settings app say
 * "saved, applies on reload" instead of raising an alarm.
 */
export type ChannelStatus = "running" | "idle" | "not-loaded";

export interface StartRuntimeResult {
  status: ChannelStatus;
  /** Why the channel is idle. Only set when `status` is `idle`. */
  idleReason?: string;
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
 * Build the provider for `config` and start its ingress.
 *
 * Never throws: a provider that cannot be built, or an ingress mode the
 * provider does not support, leaves the channel idle with a reason. Plugin
 * load and a settings edit both need to survive a bad configuration.
 */
export function startChannelRuntime(
  config: IMessageConfig,
): StartRuntimeResult {
  const ctx = getInitContext();
  if (!ctx) {
    return { status: "not-loaded" };
  }

  stopIngress();
  setConfig(config);

  // Clear the previous provider before attempting to build the new one. If the
  // build fails we must not leave the old provider active: outbound would keep
  // going out over a provider the config no longer names, while the settings
  // app reports the new one. Idle is the honest state.
  setProvider(undefined);
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
      sendChannel: config.sendChannel,
      allowedHandles: config.allowedHandles,
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
