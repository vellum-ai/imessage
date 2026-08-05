/**
 * The settings GET payload, as the app reads it.
 *
 * The app is compiled by the host, not by this repo — `apps/` is outside
 * `tsconfig.json`'s `include` and React types are not installed here — so
 * nothing type-checks the join between what this route sends and what
 * `main.tsx` destructures. These tests stand in for that: every field asserted
 * below is one the panel binds to, and renaming one here without renaming it
 * there is exactly the break they catch.
 */

import { describe, expect, test } from "bun:test";

import { handleSettingsGet } from "../app-routes.ts";
import { INGRESS_MODES } from "../config.ts";
import { PROVIDER_IDS } from "../providers/types.ts";

interface SettingsPayload {
  config: { provider: string; ingressMode: string };
  providers: string[];
  ingressModes: string[];
  activeProvider: string | null;
  credentials: Record<string, { field: string; set: boolean }[]>;
}

async function settingsPayload(): Promise<SettingsPayload> {
  const response = await handleSettingsGet();
  expect(response.status).toBe(200);
  return (await response.json()) as SettingsPayload;
}

describe("handleSettingsGet", () => {
  test("carries the config fields the panel binds to", async () => {
    const payload = await settingsPayload();
    expect(typeof payload.config.provider).toBe("string");
    expect([...INGRESS_MODES] as string[]).toContain(
      payload.config.ingressMode,
    );
  });

  test("offers every provider and every ingress mode the plugin supports", async () => {
    // The app holds the display copy and renders the intersection with these,
    // so a mode missing here silently disappears from the panel.
    const payload = await settingsPayload();
    expect(payload.providers).toEqual([...PROVIDER_IDS]);
    expect(payload.ingressModes).toEqual([...INGRESS_MODES]);
  });

  test("reports credential state without ever returning a value", async () => {
    // The panel renders a placeholder over `set`; a route that returned the
    // secret itself would put it in the sandbox for no reason.
    const payload = await settingsPayload();
    for (const provider of PROVIDER_IDS) {
      expect(payload.credentials[provider]).toBeDefined();
      for (const field of payload.credentials[provider] ?? []) {
        expect(typeof field.set).toBe("boolean");
        expect(field).not.toHaveProperty("value");
      }
    }
  });

  test("no longer advertises a list of editable keys", async () => {
    // It was a second statement of which controls exist, and it went stale:
    // `sendChannel` stayed listed long after it meant nothing on the default
    // provider. The app decides its own controls now.
    const payload = await settingsPayload();
    expect(payload).not.toHaveProperty("editableKeys");
  });
});
