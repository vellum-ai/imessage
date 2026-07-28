/**
 * `shutdown` hook — stop the poller and release in-process state.
 *
 * Runs on daemon teardown, uninstall, disable, and in-place reload. Stopping
 * the poller matters most in the reload case: `shutdown` fires before the new
 * version's `init`, so leaving the old timer running would mean two pollers
 * competing over one cursor file.
 *
 * `ShutdownContext` carries no logger, so this hook is deliberately silent.
 *
 * The poll cursor is durable and deliberately left on disk: it is what stops
 * the next boot from either replaying the backlog or skipping whatever arrived
 * while the daemon was down.
 */

import type { ShutdownContext } from "@vellumai/plugin-api";

import { getPoller, resetPluginState } from "../src/plugin-state.ts";

const shutdown = async (_ctx: ShutdownContext): Promise<void> => {
  getPoller()?.stop();
  resetPluginState();
};

export default shutdown;
