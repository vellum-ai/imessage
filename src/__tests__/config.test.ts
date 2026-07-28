import { describe, expect, test } from "bun:test";

import {
  IMessageConfigSchema,
  isAllowedHandle,
  resolveConfig,
} from "../config.ts";

describe("resolveConfig", () => {
  test("defaults to the vellum provider over webhooks", () => {
    // The default path takes a user from install to working without leaving
    // the product: no third-party account, no key to paste, and push delivery.
    const { config } = resolveConfig({});
    expect(config.provider).toBe("vellum");
    expect(config.ingressMode).toBe("webhook");
    expect(config.allowedHandles).toEqual([]);
  });

  test("accepts an absent config", () => {
    expect(resolveConfig(undefined).config.provider).toBe("vellum");
  });

  test("accepts the BYOK provider", () => {
    const { config, warnings } = resolveConfig({ provider: "comms" });
    expect(config.provider).toBe("comms");
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
    expect(config.ingressMode).toBe("webhook");
    expect(warnings.length).toBeGreaterThan(0);
  });

  test("rejects an unknown provider", () => {
    const { config, warnings } = resolveConfig({ provider: "bluebubbles" });
    expect(config.provider).toBe("vellum");
    expect(warnings.length).toBeGreaterThan(0);
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

describe("isAllowedHandle", () => {
  test("an empty allowlist admits everything", () => {
    const { config } = resolveConfig({});
    expect(isAllowedHandle(config, "+15551234567")).toBe(true);
  });

  test("a populated allowlist admits only its members", () => {
    const { config } = resolveConfig({ allowedHandles: ["+15551234567"] });
    expect(isAllowedHandle(config, "+15551234567")).toBe(true);
    expect(isAllowedHandle(config, "+15559990000")).toBe(false);
  });
});
