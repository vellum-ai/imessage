/**
 * `init` hook — plugin bootstrap.
 *
 * Runs once when the daemon loads the plugin. It validates config, builds the
 * Comms client, registers the channel provider, and starts the poller when the
 * plugin is in the default `poll` ingress mode.
 *
 * Non-fatal throughout. A missing API key means the line is not set up yet,
 * which is the normal state between installing the plugin and running the
 * setup skill — it logs and returns so the plugin still loads, rather than
 * failing boot over a credential the user has not stored yet.
 */

import type { InitContext } from "@vellumai/plugin-api";

import { buildProvider } from "../src/channel/provider.ts";
import { CommsClient } from "../src/comms/client.ts";
import { isAllowedHandle, resolveApiKey, resolveConfig } from "../src/config.ts";
import {
  setClient,
  setConfig,
  setPoller,
  setProvider,
  setStorageDir,
} from "../src/plugin-state.ts";
import { CommsPoller } from "../src/poller.ts";

const init = async (ctx: InitContext): Promise<void> => {
  const { config, warnings } = resolveConfig(ctx.config);
  for (const warning of warnings) {
    ctx.logger.warn({ warning }, `imessage config: ${warning}`);
  }

  setConfig(config);
  setStorageDir(ctx.pluginStorageDir);

  const client = new CommsClient();
  setClient(client);
  setProvider(buildProvider({ client, config }));

  // Probe the credential rather than assuming it is there. An unconfigured
  // line is the expected state right after install, so this is an info-level
  // "not set up yet", not an error.
  try {
    await resolveApiKey();
  } catch (err) {
    ctx.logger.info(
      { err },
      "imessage: no Comms API key stored yet — run the imessage-setup skill. The channel will stay idle until then.",
    );
    return;
  }

  if (config.ingressMode === "webhook") {
    ctx.logger.info(
      {},
      "imessage: webhook ingress mode — inbound arrives via /webhooks/plugins/imessage/events; no poller started",
    );
    return;
  }

  const poller = new CommsPoller({
    client,
    storageDir: ctx.pluginStorageDir,
    intervalMs: config.pollIntervalMs,
    logger: ctx.logger,
    isAllowed: (handle) => isAllowedHandle(config, handle),
    sink: async (event) => {
      // TODO(pluggable-channels): hand the event to the host's inbound
      // pipeline so it runs through the `no_one` kill switch, trust
      // classification, and the admission floor. Until the channel-provider
      // contract lands there is no host entry point to call, and posting
      // straight into a conversation would bypass every one of those checks —
      // which is exactly the gap this plugin must not open. Logging until then
      // is deliberate: the poller, cursor, and normalizer are exercised
      // end-to-end without admitting untrusted input.
      ctx.logger.info(
        {
          actorExternalId: event.actor.actorExternalId,
          conversationExternalId: event.message.conversationExternalId,
          externalMessageId: event.message.externalMessageId,
          chatType: event.source.chatType,
        },
        "imessage: normalized inbound message (not yet forwarded — awaiting host channel-provider contract)",
      );
    },
  });

  poller.start();
  setPoller(poller);

  ctx.logger.info(
    { intervalMs: config.pollIntervalMs },
    "imessage: polling the Comms Messages API for inbound messages",
  );
};

export default init;
