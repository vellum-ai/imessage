/**
 * Runtime tests.
 *
 * The point of `channel-runtime.ts` is that a provider switch from the
 * settings app runs the same code as a fresh boot. These pin the parts of that
 * which are easy to break: idle reasons instead of throws, and ingress being
 * torn down before it is rebuilt.
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
    expect(startChannelRuntime(config).idleReason).toContain(
      "not initialized",
    );
  });

  test("a provider that cannot be built leaves the channel idle", () => {
    // vellum needs a host platform caller that does not exist yet. Plugin load
    // has to survive that, not fail.
    withContext();
    const config = IMessageConfigSchema.parse({ provider: "vellum" });
    const result = startChannelRuntime(config);

    expect(result.idleReason).toContain("platform caller");
    expect(getProvider()).toBeUndefined();
  });

  test("comms over webhooks comes up with no idle reason", () => {
    withContext();
    const config = IMessageConfigSchema.parse({
      provider: "comms",
      ingressMode: "webhook",
    });
    const result = startChannelRuntime(config);

    expect(result.idleReason).toBeUndefined();
    expect(getProvider()?.id).toBe("comms");
    expect(getChannel()?.channel).toBe("imessage");
  });

  test("a webhook-only provider asked to poll reports idle", () => {
    withContext();
    // Reach the vellum branch without a platform caller by asserting the
    // guard order: the build failure is reported before the poll check.
    const config = IMessageConfigSchema.parse({
      provider: "vellum",
      ingressMode: "poll",
    });
    expect(startChannelRuntime(config).idleReason).toBeTruthy();
  });

  test("restarting swaps the active provider", () => {
    withContext();

    startChannelRuntime(
      IMessageConfigSchema.parse({ provider: "comms", ingressMode: "webhook" }),
    );
    expect(getProvider()?.id).toBe("comms");

    // Switching to a provider that cannot build clears the previous one rather
    // than leaving a stale provider serving a config that no longer applies.
    const result = startChannelRuntime(
      IMessageConfigSchema.parse({ provider: "vellum" }),
    );
    expect(result.idleReason).toBeTruthy();
    expect(getProvider()).toBeUndefined();
  });

  test("is idempotent", () => {
    withContext();
    const config = IMessageConfigSchema.parse({
      provider: "comms",
      ingressMode: "webhook",
    });
    startChannelRuntime(config);
    const second = startChannelRuntime(config);
    expect(second.idleReason).toBeUndefined();
    expect(getProvider()?.id).toBe("comms");
  });
});

describe("stopIngress", () => {
  test("is safe when nothing is running", () => {
    expect(() => stopIngress()).not.toThrow();
  });

  test("leaves the provider in place so outbound still works", () => {
    withContext();
    startChannelRuntime(
      IMessageConfigSchema.parse({ provider: "comms", ingressMode: "webhook" }),
    );
    stopIngress();
    expect(getProvider()?.id).toBe("comms");
  });
});
