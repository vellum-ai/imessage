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
  getWebhookReport,
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
  test("a save before init still brings the channel up", () => {
    // No `setInitContext` here: this is a settings save arriving on a route
    // while the hook has not run. It used to report a third status saying the
    // write applied on the next reload — true, and read as an alarm. The
    // runtime derives what it needs from its own location instead.
    const result = startChannelRuntime(IMessageConfigSchema.parse({}));

    expect(result.status).toBe("running");
    expect(result.idleReason).toBeUndefined();
    expect(getProvider()?.id).toBe("photon");
  });

  test("an unreadable provider value falls back rather than breaking", () => {
    // `config.json` is edited by hand as well as by the app, so a value the
    // schema rejects has to come up on the default, not refuse to load.
    const { config, warnings } = resolveConfig({ provider: "not-a-provider" });

    expect(config.provider).toBe("photon");
    expect(warnings.join(" ")).toContain("provider");
  });

  test("webhook ingress comes up running", () => {
    withContext();
    const result = startChannelRuntime(
      IMessageConfigSchema.parse({ ingressMode: "webhook" }),
    );

    expect(result.status).toBe("running");
    expect(result.idleReason).toBeUndefined();
    expect(getProvider()?.id).toBe("photon");
    expect(getChannel()?.channel).toBe("imessage");
  });

  test("live ingress comes up running on photon", () => {
    withContext();
    const result = startChannelRuntime(
      IMessageConfigSchema.parse({ ingressMode: "live" }),
    );

    expect(result.status).toBe("running");
    expect(result.idleReason).toBeUndefined();
    expect(getProvider()?.id).toBe("photon");
  });

  test("comms plus live leaves the channel idle", () => {
    withContext();
    const result = startChannelRuntime(
      IMessageConfigSchema.parse({ provider: "comms", ingressMode: "live" }),
    );

    expect(result.status).toBe("idle");
    expect(result.idleReason).toContain("does not support live ingress");
  });

  test("is idempotent", () => {
    withContext();
    const config = IMessageConfigSchema.parse({ ingressMode: "webhook" });

    startChannelRuntime(config);
    const second = startChannelRuntime(config);

    expect(second.status).toBe("running");
    expect(getProvider()?.id).toBe("photon");
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
    expect(getProvider()?.id).toBe("photon");

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
    expect(getProvider()?.id).toBe("photon");
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
    expect(getProvider()?.id).toBe("photon");
  });
});

describe("webhook registration reporting", () => {
  /**
   * Registration runs un-awaited and used to report itself only through the
   * logger. That made "no webhook exists and nothing says why" reachable, and
   * it was reached in QA. These pin the record that replaces the log.
   */
  async function settle(): Promise<void> {
    // Registration is deliberately not awaited by `startChannelRuntime`, so
    // let its microtasks drain before reading what it recorded.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  test("records why nothing was registered", async () => {
    // No credentials in this environment, so the attempt fails on the way to
    // the provider. What matters is that a reason exists at all.
    withContext();
    startChannelRuntime(
      IMessageConfigSchema.parse({ provider: "comms", ingressMode: "webhook" }),
    );
    await settle();

    const report = getWebhookReport();
    expect(report?.provider).toBe("comms");
    expect(["failed", "skipped"]).toContain(report?.outcome ?? "");
    expect(report?.reason?.length ?? 0).toBeGreaterThan(0);
  });

  test("attempts nothing in poll mode", async () => {
    withContext();
    startChannelRuntime(
      IMessageConfigSchema.parse({ provider: "comms", ingressMode: "poll" }),
    );
    await settle();

    expect(getWebhookReport()).toBeUndefined();
  });

  test("attempts nothing in live mode", async () => {
    withContext();
    startChannelRuntime(
      IMessageConfigSchema.parse({ provider: "photon", ingressMode: "live" }),
    );
    await settle();

    expect(getWebhookReport()).toBeUndefined();
  });

  test("names the step it got to, not just that it failed", async () => {
    // Reading the stored secret, resolving the public URL, asking the provider
    // and storing what it issued fail for unrelated reasons with unrelated
    // remedies. "failed" alone leaves a reader checking all four — which is
    // the position a real incident left us in.
    withContext();
    startChannelRuntime(
      IMessageConfigSchema.parse({ provider: "comms", ingressMode: "webhook" }),
    );
    await settle();

    const report = getWebhookReport();
    expect([
      "read-secret",
      "resolve-url",
      "call-provider",
      "store-secret",
    ]).toContain(report?.step ?? "");
  });

  test("still registers on a first run, when no secret has ever been stored", async () => {
    // A fresh install throws on the very first secret read, exactly as an
    // unreachable store does. Treating that as "could not ask" and stopping
    // would break first-time setup outright, so it must get past the secret.
    withContext();
    startChannelRuntime(
      IMessageConfigSchema.parse({ provider: "comms", ingressMode: "webhook" }),
    );
    await settle();

    expect(getWebhookReport()?.step).not.toBe("read-secret");
  });

  test("still records when no init context was ever set", async () => {
    // The path that produced the silence: a derived context used to carry a
    // no-op logger, so a failure here went nowhere at all.
    startChannelRuntime(
      IMessageConfigSchema.parse({ provider: "comms", ingressMode: "webhook" }),
    );
    await settle();

    expect(getWebhookReport()).toBeDefined();
  });
});
