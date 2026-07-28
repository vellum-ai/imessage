/**
 * The plugin's channel-provider registration.
 *
 * Binds a `MessagingProvider` to the host-facing channel shape: normalization
 * in, transport out. One object for the host's channel registry to consume.
 */

import { CHANNEL_ID } from "../plugin-paths.ts";
import type { PluginChannelProvider, PluginInboundEvent } from "./contract.ts";
import { createTransport } from "./transport.ts";
import type { MessagingProvider } from "../providers/types.ts";

export function buildChannelProvider(
  provider: MessagingProvider,
): PluginChannelProvider {
  return {
    channel: CHANNEL_ID,

    normalize(raw: unknown, receivedAt: string): PluginInboundEvent | undefined {
      return provider.normalizeWebhook(raw, receivedAt);
    },

    transport: createTransport(provider),
  };
}
