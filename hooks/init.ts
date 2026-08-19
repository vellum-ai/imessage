/**
 * `init` hook — plugin bootstrap.
 *
 * Validates config, stashes the context the runtime needs, and starts the
 * channel. The actual work lives in `src/channel-runtime.ts` so that a
 * provider switch from the configuration app runs the identical code path.
 *
 * Nothing here touches credentials. The provider resolves what it needs at
 * call time, so an unconfigured line — the normal state between install and
 * setup — costs nothing at boot.
 */

import type { InitContext } from "@vellumai/plugin-api";

import { startChannelRuntime } from "../src/channel-runtime.ts";
import { resolveConfig } from "../src/config.ts";
import { setInitContext } from "../src/plugin-state.ts";
import { pluginName } from "../src/plugin-paths.ts";

const init = async (ctx: InitContext): Promise<void> => {
  const { config, warnings } = resolveConfig(ctx.config);
  for (const warning of warnings) {
    ctx.logger.warn({ warning }, `imessage config: ${warning}`);
  }

  setInitContext({
    logger: ctx.logger,
    pluginStorageDir: ctx.pluginStorageDir,
    pluginName: pluginName(),
  });

  const { status, idleReason } = await startChannelRuntime(config);
  if (status === "idle") {
    ctx.logger.info(
      { idleReason },
      "imessage: channel is idle — change the provider from the settings app or fix the configuration",
    );
  }
};

export default init;
