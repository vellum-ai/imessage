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
      // The host contract still asks for an optional event, so the verdict is
      // collapsed here rather than at the provider seam. `probe` and `ignored`
      // both mean "not a turn" to this caller; the route below keeps them
      // apart, which is where the difference is worth something.
      const delivery = provider.classifyWebhook(raw, receivedAt);
      return delivery.kind === "message" ? delivery.event : undefined;
    },

    transport: createTransport(provider),
  };
}
