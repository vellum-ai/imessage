/**
 * In-process handles the hooks and routes share.
 *
 * `init` resolves config, builds the client, and stashes everything here;
 * `routes/events.ts` reads it to verify and normalize a webhook delivery, and
 * `shutdown` reads it to stop the poller. Nothing durable lives here — the
 * poll cursor is the plugin's only persistent state and it belongs to
 * `cursor.ts`.
 */

import type { PluginChannelProvider } from "./channel/contract.ts";
import type { CommsClient } from "./comms/client.ts";
import type { IMessageConfig } from "./config.ts";
import type { CommsPoller } from "./poller.ts";

interface PluginState {
  config?: IMessageConfig;
  client?: CommsClient;
  poller?: CommsPoller;
  provider?: PluginChannelProvider;
  storageDir?: string;
}

const state: PluginState = {};

export function setConfig(config: IMessageConfig): void {
  state.config = config;
}

export function getConfig(): IMessageConfig | undefined {
  return state.config;
}

export function setClient(client: CommsClient): void {
  state.client = client;
}

export function getClient(): CommsClient | undefined {
  return state.client;
}

export function setPoller(poller: CommsPoller | undefined): void {
  state.poller = poller;
}

export function getPoller(): CommsPoller | undefined {
  return state.poller;
}

export function setProvider(provider: PluginChannelProvider): void {
  state.provider = provider;
}

export function getProvider(): PluginChannelProvider | undefined {
  return state.provider;
}

export function setStorageDir(dir: string): void {
  state.storageDir = dir;
}

export function getStorageDir(): string | undefined {
  return state.storageDir;
}

/** Clear everything. Used by `shutdown` and by tests. */
export function resetPluginState(): void {
  state.config = undefined;
  state.client = undefined;
  state.poller = undefined;
  state.provider = undefined;
  state.storageDir = undefined;
}
