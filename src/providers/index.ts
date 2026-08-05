/**
 * Provider registry.
 *
 * The one place that maps a configured provider id onto an adapter. Callers
 * take a `MessagingProvider` and never branch on the id themselves.
 *
 * Nothing is resolved from credentials here. Both adapters read what they need
 * at call time, so an unconfigured line costs nothing at boot and building a
 * provider cannot fail for a reason the user has to go fix. `startChannelRuntime`
 * still handles a throw from here — a future provider may need something at
 * construction — but today the honest report for "no credentials yet" comes
 * from `checkReadiness`, not from a channel that refuses to load.
 */

import { createCommsProvider } from "./comms/adapter.ts";
import { createPhotonProvider } from "./photon/adapter.ts";
import type { MessagingProvider } from "./types.ts";
import { PROVIDER_IDS } from "./types.ts";
import type { IMessageConfig } from "../config.ts";
import type { MessageClientFactory } from "./photon/message-client.ts";

export interface ResolveProviderOptions {
  config: IMessageConfig;
  /**
   * Photon's message-plane factory.
   *
   * Only ever supplied by tests. The real one opens a gRPC channel on
   * construction, so without a seam here any test that reaches a send would
   * dial the network — which is exactly what happened when the plane moved off
   * `fetch` and the stubs stopped applying.
   */
  photonMessageClient?: MessageClientFactory;
}

export function resolveProvider(
  opts: ResolveProviderOptions,
): MessagingProvider {
  switch (opts.config.provider) {
    case "photon":
      return createPhotonProvider(opts.photonMessageClient);
    case "comms":
      return createCommsProvider();
    default:
      // Unreachable through the config schema, which validates against
      // `PROVIDER_IDS`. Reachable if a caller hands over a config it built
      // itself, and worth throwing rather than returning `undefined`: the
      // runtime turns a throw into an idle channel with a reason, while an
      // absent provider would fail later and further away.
      throw new Error(
        `unknown provider "${String(opts.config.provider)}" — expected one of: ${PROVIDER_IDS.join(", ")}`,
      );
  }
}
