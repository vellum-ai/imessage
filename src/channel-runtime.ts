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
import { deliverInbound } from "./inbound.ts";
import {
  getChannel,
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
 * Send a reply back over whichever channel is currently up.
 *
 * Reads the channel at call time rather than capturing it: a provider switch
 * replaces the transport, and a captured one would keep sending over the
 * provider the config no longer names.
 */
async function replyOverChannel(
  conversationExternalId: string,
  text: string,
): Promise<void> {
  const channel = getChannel();
  if (!channel) {
    throw new Error("channel is not running");
  }
  const result = await channel.transport.deliver(conversationExternalId, {
    text,
  });
  if (!result.ok) {
    throw new Error(result.error ?? "delivery failed");
  }
}

export interface StartRuntimeResult {
  /** Why the channel is idle, or `undefined` when it came up. */
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
    return { idleReason: "plugin is not initialized" };
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
    return { idleReason };
  }

  setProvider(provider);
  setChannel(buildChannelProvider(provider));

  if (config.ingressMode === "webhook") {
    ctx.logger.info(
      { provider: provider.id },
      `imessage: webhook ingress — inbound arrives at /webhooks/plugins/${ctx.pluginName}/events`,
    );
    return {};
  }

  if (!provider.supportsPolling) {
    const idleReason = `provider ${provider.id} is webhook-only but ingressMode is 'poll'`;
    ctx.logger.warn({ provider: provider.id }, `imessage: ${idleReason}`);
    return { idleReason };
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
    sink: async (event) => {
      await deliverInbound({
        event,
        config,
        storageDir: ctx.pluginStorageDir,
        logger: ctx.logger,
        reply: replyOverChannel,
      });
    },
  });

  supervisor.start();
  setSupervisor(supervisor);

  ctx.logger.info(
    { provider: provider.id, intervalMs: config.pollIntervalMs },
    "imessage: poll worker started",
  );
  return {};
}
