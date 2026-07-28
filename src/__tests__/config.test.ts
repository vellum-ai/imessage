import { describe, expect, test } from "bun:test";

import { isAllowedHandle, IMessageConfigSchema, resolveConfig } from "../config.ts";

describe("resolveConfig", () => {
  test("defaults to polling", () => {
    // Polling is the only mode built entirely on documented behavior.
    const { config } = resolveConfig({});
    expect(config.ingressMode).toBe("poll");
    expect(config.pollIntervalMs).toBe(5_000);
    expect(config.allowedHandles).toEqual([]);
  });

  test("accepts an absent config", () => {
    expect(resolveConfig(undefined).config.ingressMode).toBe("poll");
  });

  test("warns that webhook mode is unverified", () => {
    const { config, warnings } = resolveConfig({ ingressMode: "webhook" });
    expect(config.ingressMode).toBe("webhook");
    expect(warnings.join(" ")).toContain("unverified");
  });

  test("falls back to defaults on an invalid value rather than throwing", () => {
    // A bad interval should not stop the channel from loading.
    const { config, warnings } = resolveConfig({ pollIntervalMs: 5 });
    expect(config.pollIntervalMs).toBe(5_000);
    expect(warnings.length).toBeGreaterThan(0);
  });

  test("rejects an unknown ingress mode", () => {
    const { config, warnings } = resolveConfig({ ingressMode: "carrier-pigeon" });
    expect(config.ingressMode).toBe("poll");
    expect(warnings.length).toBeGreaterThan(0);
  });

  test("bounds the poll interval", () => {
    expect(IMessageConfigSchema.safeParse({ pollIntervalMs: 1_000 }).success).toBe(
      false,
    );
    expect(
      IMessageConfigSchema.safeParse({ pollIntervalMs: 400_000 }).success,
    ).toBe(false);
    expect(IMessageConfigSchema.safeParse({ pollIntervalMs: 30_000 }).success).toBe(
      true,
    );
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
