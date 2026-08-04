/**
 * Where a provider is told to deliver.
 *
 * `getWorkspaceDir` is mocked to a temp directory so these read a real
 * `config.json` off disk without touching the machine's workspace.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const realPluginApi = await import("@vellumai/plugin-api");

const workspace = mkdtempSync(join(tmpdir(), "imessage-workspace-"));

mock.module("@vellumai/plugin-api", () => ({
  ...realPluginApi,
  getWorkspaceDir: () => workspace,
}));

const { resolveWebhookEndpoint } = await import("../webhook-endpoint.ts");
const { CHANNEL_ID } = await import("../plugin-paths.ts");

function writeConfig(config: unknown): void {
  writeFileSync(join(workspace, "config.json"), JSON.stringify(config), "utf-8");
}

beforeEach(() => {
  rmSync(join(workspace, "config.json"), { force: true });
});

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("resolveWebhookEndpoint", () => {
  test("gives each provider its own path", () => {
    // The provider has to be identifiable from the URL: it decides how the
    // gateway verifies, and the gateway reads only its static manifest.
    writeConfig({ ingress: { publicBaseUrl: "https://host.example" } });

    const comms = resolveWebhookEndpoint({ provider: "comms" });
    const photon = resolveWebhookEndpoint({ provider: "photon" });

    expect(comms.ok && comms.url).toBe(
      `https://host.example/webhooks/plugins/${CHANNEL_ID}/events/comms`,
    );
    expect(photon.ok && photon.url).toBe(
      `https://host.example/webhooks/plugins/${CHANNEL_ID}/events/photon`,
    );
  });

  test("carries a shared secret in the query when one is supplied", () => {
    // Comms cannot sign, so the token in the URL is the whole proof.
    writeConfig({ ingress: { publicBaseUrl: "https://host.example" } });
    const endpoint = resolveWebhookEndpoint({
      provider: "comms",
      sharedSecret: "tok-abc",
    });

    expect(endpoint.ok && endpoint.url).toBe(
      `https://host.example/webhooks/plugins/${CHANNEL_ID}/events/comms?token=tok-abc`,
    );
  });

  test("omits the query entirely for a signing provider", () => {
    writeConfig({ ingress: { publicBaseUrl: "https://host.example" } });
    const endpoint = resolveWebhookEndpoint({ provider: "photon" });
    expect(endpoint.ok && endpoint.url).not.toContain("?");
  });

  test("does not double the slash on a base that ends in one", () => {
    // A pasted base URL keeps its trailing slash more often than not, and the
    // gateway matches the declared path exactly — `//events` is a 404.
    writeConfig({ ingress: { publicBaseUrl: "https://host.example/" } });
    const endpoint = resolveWebhookEndpoint({ provider: "comms" });

    expect(endpoint.ok && endpoint.url).toContain("example/webhooks/");
  });

  test("reports a reason rather than guessing when no base is configured", () => {
    // Registering a wrong URL is worse than registering none: the provider
    // then reports a healthy webhook pointing nowhere.
    writeConfig({ ingress: { publicBaseUrl: "" } });
    const endpoint = resolveWebhookEndpoint({ provider: "comms" });

    expect(endpoint.ok).toBe(false);
    if (!endpoint.ok) expect(endpoint.reason).toContain("publicBaseUrl");
  });

  test("an absent config is the same answer as an unset base", () => {
    expect(resolveWebhookEndpoint({ provider: "comms" }).ok).toBe(false);
  });

  test("an unparsable config does not throw", () => {
    writeFileSync(join(workspace, "config.json"), "{ not json", "utf-8");
    const read = () => resolveWebhookEndpoint({ provider: "comms" });
    expect(read).not.toThrow();
    expect(read().ok).toBe(false);
  });
});
