import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  applyConfigUpdate,
  applyProviderChange,
  ConfigUpdateSchema,
  ConfigValidationError,
  CredentialUpdateSchema,
  ProviderChangeSchema,
  readConfigView,
} from "../app-settings.ts";
import { PROVIDER_CREDENTIALS } from "../config.ts";
import { PROVIDER_IDS } from "../providers/types.ts";

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

describe("CredentialUpdateSchema", () => {
  test("accepts a provider and its values", () => {
    expect(
      CredentialUpdateSchema.safeParse({
        provider: "photon",
        values: { photon_project_id: "proj_1" },
      }).success,
    ).toBe(true);
  });

  test("rejects an unknown provider", () => {
    expect(
      CredentialUpdateSchema.safeParse({
        provider: "bluebubbles",
        values: {},
      }).success,
    ).toBe(false);
  });

  test("rejects a non-string value rather than storing it stringified", () => {
    expect(
      CredentialUpdateSchema.safeParse({
        provider: "comms",
        values: { api_key: 12345 },
      }).success,
    ).toBe(false);
  });

  test("rejects extra keys", () => {
    expect(
      CredentialUpdateSchema.safeParse({
        provider: "comms",
        values: {},
        also: "no",
      }).success,
    ).toBe(false);
  });
});

describe("provider credentials", () => {
  test("every provider declares what it needs", () => {
    // The settings app renders this list and each adapter resolves from it, so
    // a provider missing an entry is a provider the app cannot configure.
    for (const id of PROVIDER_IDS) {
      expect(PROVIDER_CREDENTIALS[id].length).toBeGreaterThan(0);
    }
  });

  test("fields are unique across providers", () => {
    // One credential service backs both, so two providers sharing a field name
    // would have one silently overwrite the other's value.
    const fields = PROVIDER_IDS.flatMap((id) =>
      PROVIDER_CREDENTIALS[id].map((spec) => spec.field),
    );
    expect(new Set(fields).size).toBe(fields.length);
  });

  test("every field carries the label and hint the app renders", () => {
    for (const id of PROVIDER_IDS) {
      for (const spec of PROVIDER_CREDENTIALS[id]) {
        expect(spec.label.length).toBeGreaterThan(0);
        expect(spec.hint.length).toBeGreaterThan(0);
      }
    }
  });
});
