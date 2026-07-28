/**
 * `init` hook — plugin bootstrap.
 *
 * Resolves config, builds the configured provider, and registers the channel.
 * In the default webhook mode that is all it does: the route handles inbound
 * and nothing needs to run in the background. In poll mode it also starts the
 * worker supervisor.
 *
 * Nothing here touches credentials. The provider resolves what it needs at
 * call time, so an unconfigured line — the normal state between install and
 * setup — costs nothing at boot and needs no probe.
 */

import type { InitContext } from "@vellumai/plugin-api";

import { buildChannelProvider } from "../src/channel/provider.ts";
import { resolveConfig } from "../src/config.ts";
import {
  setChannel,
  setConfig,
  setProvider,
  setStorageDir,
  setSupervisor,
} from "../src/plugin-state.ts";
import { resolveProvider } from "../src/providers/index.ts";
import { PollWorkerSupervisor } from "../src/worker/supervisor.ts";

const init = async (ctx: InitContext): Promise<void> => {
  const { config, warnings } = resolveConfig(ctx.config);
  for (const warning of warnings) {
    ctx.logger.warn({ warning }, `imessage config: ${warning}`);
  }

  setConfig(config);
  setStorageDir(ctx.pluginStorageDir);

  let provider;
  try {
    provider = resolveProvider({ config });
  } catch (err) {
    // A provider that cannot be constructed (e.g. vellum with no platform
    // caller) leaves the channel idle rather than failing plugin load.
    ctx.logger.warn(
      { err, provider: config.provider },
      "imessage: could not build the configured provider — the channel will stay idle",
    );
    return;
  }

  setProvider(provider);
  setChannel(buildChannelProvider(provider));

  if (config.ingressMode === "webhook") {
    ctx.logger.info(
      { provider: provider.id },
      "imessage: webhook ingress — inbound arrives at /webhooks/plugins/imessage/events",
    );
    return;
  }

  if (!provider.supportsPolling) {
    ctx.logger.warn(
      { provider: provider.id },
      "imessage: ingressMode is 'poll' but this provider is webhook-only — no poller started",
    );
    return;
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
};

export default init;
