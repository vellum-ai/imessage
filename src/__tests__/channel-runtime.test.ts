/**
 * Runtime tests.
 *
 * The point of `channel-runtime.ts` is that a restart from the settings app
 * runs the same code as a fresh boot. These pin the parts of that which are
 * easy to break: reporting a status instead of throwing, and clearing the
 * previous provider before building a replacement.
 *
 * The failure paths need a provider that cannot be built. Both shipping
 * providers can be, so these reach that branch with a config naming a provider
 * the registry does not have.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { startChannelRuntime, stopIngress } from "../channel-runtime.ts";
import type { IMessageConfig } from "../config.ts";
import { IMessageConfigSchema, resolveConfig } from "../config.ts";
import {
  getChannel,
  getProvider,
  resetPluginState,
  setInitContext,
} from "../plugin-state.ts";
import type { ProviderId } from "../providers/types.ts";

/**
 * A config naming a provider the registry does not have.
 *
 * Built by hand rather than through the schema, because the schema is what
 * stops this from reaching the runtime in the first place: it rejects an
 * unknown id and falls back to defaults. What is under test here is the layer
 * below that, which has to survive being handed one anyway.
 */
function configNamingMissingProvider(): IMessageConfig {
  return {
    ...IMessageConfigSchema.parse({}),
    provider: "no-such-provider" as ProviderId,
  };
}

const SILENT_LOGGER = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "imessage-runtime-"));
  resetPluginState();
});

afterEach(() => {
  stopIngress();
  resetPluginState();
  rmSync(dir, { recursive: true, force: true });
});

function withContext(): void {
  setInitContext({
    logger: SILENT_LOGGER,
    pluginStorageDir: dir,
    pluginName: "imessage",
  });
}

describe("startChannelRuntime", () => {
  test("with no plugin loaded it says so instead of claiming idle", () => {
    // The case a user hit by clicking a provider: the config write lands, but
    // there is no running channel in this process to restart. Reporting that
    // as idle read as "your channel just broke" — it had not.
    const result = startChannelRuntime(IMessageConfigSchema.parse({}));

    expect(result.status).toBe("not-loaded");
    expect(result.idleReason).toBeUndefined();
  });

  test("an unreadable provider value falls back rather than breaking", () => {
    // `config.json` is edited by hand as well as by the app, so a value the
    // schema rejects has to come up on the default, not refuse to load.
    const { config, warnings } = resolveConfig({ provider: "not-a-provider" });

    expect(config.provider).toBe("comms");
    expect(warnings.join(" ")).toContain("provider");
  });

  test("webhook ingress comes up running", () => {
    withContext();
    const result = startChannelRuntime(
      IMessageConfigSchema.parse({ ingressMode: "webhook" }),
    );

    expect(result.status).toBe("running");
    expect(result.idleReason).toBeUndefined();
    expect(getProvider()?.id).toBe("comms");
    expect(getChannel()?.channel).toBe("imessage");
  });

  test("is idempotent", () => {
    withContext();
    const config = IMessageConfigSchema.parse({ ingressMode: "webhook" });

    startChannelRuntime(config);
    const second = startChannelRuntime(config);

    expect(second.status).toBe("running");
    expect(getProvider()?.id).toBe("comms");
  });

  test("a provider that cannot be built leaves the channel idle", () => {
    // Plugin load has to survive a provider that throws rather than fail.
    withContext();
    const result = startChannelRuntime(configNamingMissingProvider());

    expect(result.status).toBe("idle");
    expect(result.idleReason).toContain("unknown provider");
    expect(getProvider()).toBeUndefined();
  });

  test("a failed switch clears the previous provider", () => {
    // Leaving the old provider active would keep sending over a provider the
    // config no longer names, while the settings app reported the new one.
    withContext();
    startChannelRuntime(IMessageConfigSchema.parse({ ingressMode: "webhook" }));
    expect(getProvider()?.id).toBe("comms");

    const result = startChannelRuntime(configNamingMissingProvider());

    expect(result.idleReason).toBeTruthy();
    expect(getProvider()).toBeUndefined();
    expect(getChannel()).toBeUndefined();
  });

  test("a restart rebuilds the channel rather than reusing the old one", () => {
    withContext();
    const config = IMessageConfigSchema.parse({ ingressMode: "webhook" });

    startChannelRuntime(config);
    const first = getChannel();
    startChannelRuntime(config);

    expect(getChannel()).not.toBe(first);
    expect(getProvider()?.id).toBe("comms");
  });
});

describe("stopIngress", () => {
  test("is safe when nothing is running", () => {
    expect(() => stopIngress()).not.toThrow();
  });

  test("leaves the provider in place so outbound still works", () => {
    // Inbound being down should not take sending with it.
    withContext();
    startChannelRuntime(
      IMessageConfigSchema.parse({ ingressMode: "webhook" }),
    );
    stopIngress();
    expect(getProvider()?.id).toBe("comms");
  });
});
