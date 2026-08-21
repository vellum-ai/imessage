/**
 * Provider-switch persistence: the new provider is started first, and the
 * config file is only written if that start succeeds.
 *
 * `resolveCredential` is mocked to throw so Photon's readiness check and
 * webhook registration fail the same way a missing project id does. The
 * webhook URL resolver is stubbed so registration gets as far as asking
 * Photon rather than stopping on "no public URL".
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const realPluginApi = await import("@vellumai/plugin-api");

mock.module("@vellumai/plugin-api", () => ({
  ...realPluginApi,
  resolveCredential: mock(async () => {
    throw new Error("credential not found");
  }),
}));

const { switchChannelProvider } = await import("../app-routes.ts");
const { startChannelRuntime, stopIngress } =
  await import("../channel-runtime.ts");
const { IMessageConfigSchema } = await import("../config.ts");
const { resetPluginState, setInitContext } =
  await import("../plugin-state.ts");
const { describeWebhookFailure } = await import("../webhook-report.ts");
const { setWebhookUrlResolverOverride } =
  await import("../webhook-endpoint.ts");

const SILENT_LOGGER = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "imessage-switch-"));
  resetPluginState();
  setInitContext({
    logger: SILENT_LOGGER,
    pluginStorageDir: dir,
    pluginName: "imessage",
  });
  setWebhookUrlResolverOverride(async () => {
    return "https://example.com/webhooks/plugins/imessage/events-photon/";
  });
});

afterEach(async () => {
  setWebhookUrlResolverOverride(undefined);
  await stopIngress();
  resetPluginState();
  rmSync(dir, { recursive: true, force: true });
});

describe("describeWebhookFailure", () => {
  test("names the step and quotes the provider's reason", () => {
    expect(
      describeWebhookFailure({
        provider: "photon",
        outcome: "failed",
        step: "call-provider",
        reason: "The Photon project ID could not be read: credential not found",
        at: "2026-08-18T12:00:00.000Z",
      }),
    ).toBe(
      "Webhook registration failed (call-provider): The Photon project ID could not be read: credential not found",
    );
  });
});

describe("startChannelRuntime waitForSetup", () => {
  test("live ingress idles when the project id cannot be resolved", async () => {
    const result = await startChannelRuntime(
      IMessageConfigSchema.parse({ provider: "photon", ingressMode: "live" }),
      { waitForSetup: true },
    );

    expect(result.status).toBe("idle");
    expect(result.idleReason).toContain("Photon project ID could not be read");
  });

  test("webhook ingress idles with the registration-failed wording", async () => {
    const result = await startChannelRuntime(
      IMessageConfigSchema.parse({
        provider: "photon",
        ingressMode: "webhook",
      }),
      { waitForSetup: true },
    );

    expect(result.status).toBe("idle");
    expect(result.idleReason).toContain("Webhook registration failed");
    expect(result.idleReason).toContain("Photon project ID could not be read");
  });
});

describe("switchChannelProvider", () => {
  test("does not write the new provider when live setup fails", async () => {
    const configPath = join(dir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ provider: "comms", ingressMode: "webhook" }),
      "utf-8",
    );

    const switched = await switchChannelProvider(configPath, {
      provider: "photon",
      ingressMode: "live",
    });

    expect(switched.ok).toBe(false);
    if (!switched.ok) {
      expect(switched.error).toContain("Photon project ID could not be read");
    }
    expect(JSON.parse(readFileSync(configPath, "utf-8")).provider).toBe(
      "comms",
    );
  });

  test("does not write the new provider when webhook registration fails", async () => {
    const configPath = join(dir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ provider: "comms", ingressMode: "webhook" }),
      "utf-8",
    );

    const switched = await switchChannelProvider(configPath, {
      provider: "photon",
      ingressMode: "webhook",
    });

    expect(switched.ok).toBe(false);
    if (!switched.ok) {
      expect(switched.error).toContain("Webhook registration failed");
    }
    expect(JSON.parse(readFileSync(configPath, "utf-8"))).toEqual({
      provider: "comms",
      ingressMode: "webhook",
    });
  });

  test("writes the provider once the channel comes up", async () => {
    const configPath = join(dir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ provider: "photon", ingressMode: "webhook" }),
      "utf-8",
    );

    const switched = await switchChannelProvider(configPath, {
      provider: "photon",
      ingressMode: "poll",
    });

    expect(switched.ok).toBe(true);
    expect(JSON.parse(readFileSync(configPath, "utf-8"))).toEqual({
      provider: "photon",
      ingressMode: "poll",
    });
  });

  test("can bounce an already-selected Comms provider", async () => {
    const configPath = join(dir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ provider: "comms", ingressMode: "poll" }),
      "utf-8",
    );

    const switched = await switchChannelProvider(configPath, {
      provider: "comms",
      ingressMode: "poll",
    });

    expect(switched.ok).toBe(true);
    expect(JSON.parse(readFileSync(configPath, "utf-8"))).toEqual({
      provider: "comms",
      ingressMode: "poll",
    });
  });

  test("refuses to switch onto Comms while it is coming soon", async () => {
    const configPath = join(dir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ provider: "photon", ingressMode: "live" }),
      "utf-8",
    );

    const switched = await switchChannelProvider(configPath, {
      provider: "comms",
      ingressMode: "webhook",
    });

    expect(switched.ok).toBe(false);
    if (!switched.ok) {
      expect(switched.error).toBe("Coming soon");
    }
    expect(JSON.parse(readFileSync(configPath, "utf-8"))).toEqual({
      provider: "photon",
      ingressMode: "live",
    });
  });
});
