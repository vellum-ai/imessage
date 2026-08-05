/**
 * `shutdown` hook — stop the poll worker and release in-process state.
 *
 * Runs on daemon teardown, uninstall, disable, and in-place reload. Stopping
 * the supervisor matters most in the reload case: `shutdown` fires before the
 * new version's `init`, so leaving the old worker running would mean two
 * processes competing over one cursor file.
 *
 * `ShutdownContext` carries no logger, so this hook is deliberately silent.
 *
 * The poll cursor is durable and deliberately left on disk: it is what stops
 * the next boot from either replaying the backlog or skipping whatever arrived
 * while the daemon was down.
 */

import type { ShutdownContext } from "@vellumai/plugin-api";

import { getProvider, getSupervisor, resetPluginState } from "../src/plugin-state.ts";

const shutdown = async (_ctx: ShutdownContext): Promise<void> => {
  getSupervisor()?.stop();
  // Awaited, unlike the provider swap during a settings save: on a reload this
  // hook runs before the next version's `init`, and Photon's message plane is
  // a real gRPC connection. Leaving it to be collected would hand the new
  // instance a second channel against the same line.
  await getProvider()
    ?.close?.()
    .catch(() => {});
  resetPluginState();
};

export default shutdown;
