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
import { resetPluginState, setWebhookReport } from "../plugin-state.ts";
import { INGRESS_MODES } from "../config.ts";
import { PROVIDER_IDS } from "../providers/types.ts";

interface SettingsPayload {
  config: { provider: string; ingressMode: string };
  providers: string[];
  unavailableProviders: { id: string; reason: string }[];
  ingressModes: string[];
  activeProvider: string | null;
  credentials: Record<string, { field: string; set: boolean }[]>;
  webhook: { provider: string; outcome: string; reason?: string } | null;
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

  test("marks Comms as coming soon so the panel can disable it", async () => {
    // Comms is implemented but not selectable. The panel still lists it,
    // disabled, and uses this reason as the option title.
    const payload = await settingsPayload();
    expect(payload.unavailableProviders).toEqual([
      { id: "comms", reason: "Coming soon" },
    ]);
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

  test("reports the last webhook registration attempt", async () => {
    // Registration runs un-awaited and reported itself only through the
    // logger, so "no webhook exists and nothing says why" was reachable and
    // was reached. This is the answer without the daemon's log.
    setWebhookReport({
      provider: "comms",
      outcome: "failed",
      reason: "403 — scope comms_webhooks missing",
      at: "2026-08-06T12:00:00.000Z",
    });

    const payload = await settingsPayload();
    expect(payload.webhook?.outcome).toBe("failed");
    expect(payload.webhook?.reason).toContain("comms_webhooks");
  });

  test("says so when nothing has attempted a registration", async () => {
    resetPluginState();
    const payload = await settingsPayload();
    expect(payload.webhook).toBeNull();
  });

  test("no longer advertises a list of editable keys", async () => {
    // It was a second statement of which controls exist, and it went stale:
    // `sendChannel` stayed listed long after it meant nothing on the default
    // provider. The app decides its own controls now.
    const payload = await settingsPayload();
    expect(payload).not.toHaveProperty("editableKeys");
  });
});
