/**
 * Runtime tests.
 *
 * The point of `channel-runtime.ts` is that a restart from the settings app
 * runs the same code as a fresh boot. These pin the parts of that which are
 * easy to break: reporting idle instead of throwing, and clearing the previous
 * provider before building a replacement.
 *
 * `vellum` is the unbuildable provider these use as a fixture — nothing injects
 * a platform caller yet — which is what makes the failure paths reachable.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { startChannelRuntime, stopIngress } from "../channel-runtime.ts";
import { IMessageConfigSchema } from "../config.ts";
import {
  getChannel,
  getProvider,
  resetPluginState,
  setInitContext,
} from "../plugin-state.ts";

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
  test("without an init context it reports idle rather than throwing", () => {
    const config = IMessageConfigSchema.parse({});
    expect(startChannelRuntime(config).idleReason).toContain("not initialized");
  });

  test("webhook ingress comes up with no idle reason", () => {
    withContext();
    const result = startChannelRuntime(
      IMessageConfigSchema.parse({ ingressMode: "webhook" }),
    );

    expect(result.idleReason).toBeUndefined();
    expect(getProvider()?.id).toBe("comms");
    expect(getChannel()?.channel).toBe("imessage");
  });

  test("is idempotent", () => {
    withContext();
    const config = IMessageConfigSchema.parse({ ingressMode: "webhook" });

    startChannelRuntime(config);
    const second = startChannelRuntime(config);

    expect(second.idleReason).toBeUndefined();
    expect(getProvider()?.id).toBe("comms");
  });

  test("a provider that cannot be built leaves the channel idle", () => {
    // Nothing injects a platform caller for vellum yet. Plugin load has to
    // survive that rather than fail.
    withContext();
    const result = startChannelRuntime(
      IMessageConfigSchema.parse({ provider: "vellum" }),
    );

    expect(result.idleReason).toContain("platform caller");
    expect(getProvider()).toBeUndefined();
  });

  test("a failed switch clears the previous provider", () => {
    // Leaving the old provider active would keep sending over a provider the
    // config no longer names, while the settings app reported the new one.
    withContext();
    startChannelRuntime(IMessageConfigSchema.parse({ ingressMode: "webhook" }));
    expect(getProvider()?.id).toBe("comms");

    const result = startChannelRuntime(
      IMessageConfigSchema.parse({ provider: "vellum" }),
    );

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
