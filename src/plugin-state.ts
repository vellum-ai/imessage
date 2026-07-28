/**
 * In-process handles the hooks and routes share.
 *
 * `init` stashes the resolved config, the provider, and the worker supervisor;
 * `routes/events.ts` reads the provider to normalize a delivery, and
 * `shutdown` reads the supervisor to stop it. Nothing durable lives here — the
 * poll cursor is the only persistent state and it belongs to `cursor.ts`.
 */

import type { PluginChannelProvider } from "./channel/contract.ts";
import type { IMessageConfig } from "./config.ts";
import type { MessagingProvider } from "./providers/types.ts";
import type { PollWorkerSupervisor } from "./worker/supervisor.ts";

interface PluginState {
  config?: IMessageConfig;
  provider?: MessagingProvider;
  channel?: PluginChannelProvider;
  supervisor?: PollWorkerSupervisor;
  storageDir?: string;
}

const state: PluginState = {};

export function setConfig(config: IMessageConfig): void {
  state.config = config;
}

export function getConfig(): IMessageConfig | undefined {
  return state.config;
}

export function setProvider(provider: MessagingProvider): void {
  state.provider = provider;
}

export function getProvider(): MessagingProvider | undefined {
  return state.provider;
}

export function setChannel(channel: PluginChannelProvider): void {
  state.channel = channel;
}

export function getChannel(): PluginChannelProvider | undefined {
  return state.channel;
}

export function setSupervisor(
  supervisor: PollWorkerSupervisor | undefined,
): void {
  state.supervisor = supervisor;
}

export function getSupervisor(): PollWorkerSupervisor | undefined {
  return state.supervisor;
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
  state.provider = undefined;
  state.channel = undefined;
  state.supervisor = undefined;
  state.storageDir = undefined;
}
