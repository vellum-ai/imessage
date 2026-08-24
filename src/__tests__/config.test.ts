import { describe, expect, test } from "bun:test";

import { IMessageConfigSchema, resolveConfig } from "../config.ts";

describe("resolveConfig", () => {
  test("defaults to photon over live gRPC", () => {
    // Bring-your-own is the only path either way: dedicated lines are priced
    // per line by every vendor that offers them, so there is nothing to bundle.
    const { config } = resolveConfig({});
    expect(config.provider).toBe("photon");
    expect(config.ingressMode).toBe("live");
  });

  test("accepts an absent config", () => {
    expect(resolveConfig(undefined).config.provider).toBe("photon");
  });

  test("accepts an explicit provider", () => {
    const { config, warnings } = resolveConfig({ provider: "comms" });
    expect(config.provider).toBe("comms");
    // Comms has no live stream, so the live default is read as webhook.
    expect(config.ingressMode).toBe("webhook");
    expect(warnings).toEqual([]);
  });

  test("reads comms plus live as webhook", () => {
    const { config } = resolveConfig({
      provider: "comms",
      ingressMode: "live",
    });
    expect(config.provider).toBe("comms");
    expect(config.ingressMode).toBe("webhook");
  });

  test("reads linq plus live as webhook", () => {
    const { config } = resolveConfig({
      provider: "linq",
      ingressMode: "live",
    });
    expect(config.provider).toBe("linq");
    expect(config.ingressMode).toBe("webhook");
  });

  test("accepts an explicit linq webhook", () => {
    const { config, warnings } = resolveConfig({
      provider: "linq",
      ingressMode: "webhook",
    });
    expect(config.provider).toBe("linq");
    expect(config.ingressMode).toBe("webhook");
    expect(warnings).toEqual([]);
  });

  test("accepts poll mode for deployments with no public ingress", () => {
    const { config } = resolveConfig({
      provider: "comms",
      ingressMode: "poll",
      pollIntervalMs: 10_000,
    });
    expect(config.ingressMode).toBe("poll");
    expect(config.pollIntervalMs).toBe(10_000);
  });

  test("accepts live mode for Photon's gRPC stream", () => {
    const { config } = resolveConfig({
      provider: "photon",
      ingressMode: "live",
    });
    expect(config.ingressMode).toBe("live");
  });

  test("falls back to defaults on an invalid value rather than throwing", () => {
    // A bad interval should not stop the channel from loading.
    const { config, warnings } = resolveConfig({ pollIntervalMs: 5 });
    expect(config.pollIntervalMs).toBe(5_000);
    expect(warnings.length).toBeGreaterThan(0);
  });

  test("rejects an unknown ingress mode", () => {
    const { config, warnings } = resolveConfig({
      ingressMode: "carrier-pigeon",
    });
    expect(config.ingressMode).toBe("live");
    expect(warnings.length).toBeGreaterThan(0);
  });

  test("rejects an unknown provider", () => {
    const { config, warnings } = resolveConfig({ provider: "bluebubbles" });
    expect(config.provider).toBe("photon");
    expect(warnings.length).toBeGreaterThan(0);
  });

  test("keeps an explicit photon webhook rather than migrating it to live", () => {
    const { config } = resolveConfig({
      provider: "photon",
      ingressMode: "webhook",
    });
    expect(config.ingressMode).toBe("webhook");
  });

  test("bounds the poll interval", () => {
    expect(
      IMessageConfigSchema.safeParse({ pollIntervalMs: 1_000 }).success,
    ).toBe(false);
    expect(
      IMessageConfigSchema.safeParse({ pollIntervalMs: 400_000 }).success,
    ).toBe(false);
    expect(
      IMessageConfigSchema.safeParse({ pollIntervalMs: 30_000 }).success,
    ).toBe(true);
  });
});
