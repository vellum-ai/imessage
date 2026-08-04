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

export interface ResolveProviderOptions {
  config: IMessageConfig;
}

export function resolveProvider(
  opts: ResolveProviderOptions,
): MessagingProvider {
  switch (opts.config.provider) {
    case "photon":
      return createPhotonProvider();
    case "comms":
      return createCommsProvider({ sendChannel: opts.config.sendChannel });
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
