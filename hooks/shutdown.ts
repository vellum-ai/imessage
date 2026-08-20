/**
 * `shutdown` hook — stop ingress and release in-process state.
 *
 * Runs on assistant teardown, uninstall, disable, and in-place reload.
 * Stopping ingress matters most on disable and reload: `shutdown` fires
 * before the next `init` (or instead of it), so leaving the old poll worker
 * or live stream running would keep Photon's gRPC channel up with no owner.
 *
 * `ShutdownContext` carries no logger, so this hook is deliberately silent.
 *
 * The poll cursor and live seen-ids are durable and deliberately left on
 * disk: they are what stop the next boot from either replaying the backlog
 * or skipping whatever arrived while the daemon was down.
 */

import type { ShutdownContext } from "@vellumai/plugin-api";

import { stopIngress } from "../src/channel-runtime.ts";
import { getProvider, resetPluginState } from "../src/plugin-state.ts";

const shutdown = async (_ctx: ShutdownContext): Promise<void> => {
  // Await the live subscribe close before the provider's gRPC channel: a
  // disable or reload that returns while the stream is still open leaves
  // Photon's connection up with no owner.
  await stopIngress();
  await getProvider()
    ?.close?.()
    .catch(() => {});
  resetPluginState();
};

export default shutdown;
