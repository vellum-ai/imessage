/**
 * The plugin's channel-provider registration.
 *
 * One object tying the inbound and outbound halves together, which is what the
 * host's channel registry consumes once the pluggable-channel work lands. Until
 * then it is what the hooks and the webhook route share, so the eventual
 * registration is a one-line change rather than a refactor.
 */

import type { PluginChannelProvider, PluginInboundEvent } from "./contract.ts";
import { IMESSAGE_CHANNEL, normalizeCommsMessage } from "./normalize.ts";
import { createTransport } from "./transport.ts";
import type { CommsClient } from "../comms/client.ts";
import type { IMessageConfig } from "../config.ts";

export interface BuildProviderOptions {
  client: CommsClient;
  config: IMessageConfig;
}

export function buildProvider(
  opts: BuildProviderOptions,
): PluginChannelProvider {
  return {
    channel: IMESSAGE_CHANNEL,

    normalize(raw: unknown, receivedAt: string): PluginInboundEvent | undefined {
      return normalizeCommsMessage(raw, receivedAt);
    },

    transport: createTransport({
      client: opts.client,
      sendChannel: opts.config.sendChannel,
    }),
  };
}
