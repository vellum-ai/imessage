import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  applyConfigUpdate,
  applyProviderChange,
  ConfigUpdateSchema,
  ConfigValidationError,
  ProviderChangeSchema,
  readConfigView,
} from "../app-settings.ts";

let dir: string;
let configPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "imessage-settings-"));
  configPath = join(dir, "config.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readConfigView", () => {
  test("a missing config reads as all-defaults", () => {
    const view = readConfigView(configPath);
    expect(view.provider).toBe("comms");
    expect(view.ingressMode).toBe("webhook");
  });

  test("an unparsable config degrades to defaults", () => {
    // A hand-edited config with a trailing comma should not brick the app.
    writeFileSync(configPath, "{ not json", "utf-8");
    expect(readConfigView(configPath).provider).toBe("comms");
  });

  test("a non-object config degrades to defaults", () => {
    writeFileSync(configPath, "[1,2,3]", "utf-8");
    expect(readConfigView(configPath).provider).toBe("comms");
  });

  test("reads stored values", () => {
    writeFileSync(
      configPath,
      JSON.stringify({ provider: "comms", ingressMode: "poll" }),
      "utf-8",
    );
    const view = readConfigView(configPath);
    expect(view.provider).toBe("comms");
    expect(view.ingressMode).toBe("poll");
  });
});

describe("applyConfigUpdate", () => {
  test("merges rather than replaces", () => {
    // Fields the app does not surface must survive an edit.
    writeFileSync(
      configPath,
      JSON.stringify({ provider: "comms", someFutureKey: "keep me" }),
      "utf-8",
    );

    const view = applyConfigUpdate(configPath, { ingressMode: "poll" });

    expect(view.provider).toBe("comms");
    expect(view.ingressMode).toBe("poll");
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(raw.someFutureKey).toBe("keep me");
  });

  test("rejects an out-of-range value before writing it", () => {
    writeFileSync(configPath, JSON.stringify({ provider: "comms" }), "utf-8");

    expect(() =>
      applyConfigUpdate(configPath, { pollIntervalMs: 5 }),
    ).toThrow(ConfigValidationError);

    // The rejected value must not have been persisted.
    expect(JSON.parse(readFileSync(configPath, "utf-8")).pollIntervalMs).toBe(
      undefined,
    );
  });

  test("writes to a fresh config file", () => {
    const view = applyConfigUpdate(configPath, { sendChannel: "sms" });
    expect(view.sendChannel).toBe("sms");
    expect(readConfigView(configPath).sendChannel).toBe("sms");
  });
});

describe("ConfigUpdateSchema", () => {
  test("rejects provider so switching goes through its own route", () => {
    // Switching providers restarts ingress; a silent PATCH would leave the
    // running provider and the stored one disagreeing.
    expect(ConfigUpdateSchema.safeParse({ provider: "comms" }).success).toBe(
      false,
    );
  });

  test("rejects unknown keys", () => {
    expect(ConfigUpdateSchema.safeParse({ nope: 1 }).success).toBe(false);
  });

  test("accepts the editable fields", () => {
    expect(
      ConfigUpdateSchema.safeParse({
        ingressMode: "poll",
        pollIntervalMs: 10_000,
        sendChannel: "imessage",
        allowedHandles: ["+15551234567"],
      }).success,
    ).toBe(true);
  });
});

describe("applyProviderChange", () => {
  test("persists the provider and keeps other fields", () => {
    writeFileSync(
      configPath,
      JSON.stringify({ allowedHandles: ["+1555"] }),
      "utf-8",
    );

    const view = applyProviderChange(configPath, { provider: "comms" });

    expect(view.provider).toBe("comms");
    expect(view.allowedHandles).toEqual(["+1555"]);
  });

  test("rejects an unknown provider", () => {
    expect(
      ProviderChangeSchema.safeParse({ provider: "bluebubbles" }).success,
    ).toBe(false);
  });

  test("rejects extra keys", () => {
    expect(
      ProviderChangeSchema.safeParse({ provider: "comms", extra: 1 }).success,
    ).toBe(false);
  });
});
