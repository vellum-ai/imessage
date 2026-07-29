/**
 * Provider registry.
 *
 * The one place that maps a configured provider id onto an adapter. Callers
 * take a `MessagingProvider` and never branch on the id themselves.
 */

import { createCommsProvider } from "./comms/adapter.ts";
import type { MessagingProvider } from "./types.ts";
import type { IMessageConfig } from "../config.ts";

export interface ResolveProviderOptions {
  config: IMessageConfig;
}

export function resolveProvider(
  opts: ResolveProviderOptions,
): MessagingProvider {
  switch (opts.config.provider) {
    case "comms":
      return createCommsProvider({ sendChannel: opts.config.sendChannel });
  }
}
