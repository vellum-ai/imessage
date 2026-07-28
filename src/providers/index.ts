/**
 * Provider registry.
 *
 * The one place that maps a configured provider id onto an adapter. Callers
 * take a `MessagingProvider` and never branch on the id themselves.
 */

import { createCommsProvider } from "./comms/adapter.ts";
import type { MessagingProvider } from "./types.ts";
import { createVellumProvider } from "./vellum/adapter.ts";
import type { PlatformFetch } from "./vellum/endpoints.ts";
import type { IMessageConfig } from "../config.ts";
import { resolveApiKey } from "../config.ts";

export interface ResolveProviderOptions {
  config: IMessageConfig;
  /** Host-supplied platform caller. Required by the `vellum` provider. */
  platformFetch?: PlatformFetch;
}

export function resolveProvider(
  opts: ResolveProviderOptions,
): MessagingProvider {
  switch (opts.config.provider) {
    case "comms":
      return createCommsProvider({
        getApiKey: resolveApiKey,
        sendChannel: opts.config.sendChannel,
      });
    case "vellum": {
      if (!opts.platformFetch) {
        throw new Error(
          "the vellum provider needs a platform caller from the host; set provider to 'comms' to use your own Comms account",
        );
      }
      return createVellumProvider({ platformFetch: opts.platformFetch });
    }
  }
}
