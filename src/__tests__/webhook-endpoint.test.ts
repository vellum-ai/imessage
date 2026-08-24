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
  test("gives each provider its own path", async () => {
    // The provider has to be identifiable from the URL: it decides how the
    // gateway verifies, and the gateway reads only its static manifest.
    writeConfig({ ingress: { publicBaseUrl: "https://host.example" } });

    const comms = await resolveWebhookEndpoint("comms");
    const photon = await resolveWebhookEndpoint("photon");
    const linq = await resolveWebhookEndpoint("linq");

    expect(comms.ok && comms.url).toBe(
      `https://host.example/webhooks/plugins/${CHANNEL_ID}/events-comms/`,
    );
    expect(photon.ok && photon.url).toBe(
      `https://host.example/webhooks/plugins/${CHANNEL_ID}/events-photon/`,
    );
    expect(linq.ok && linq.url).toBe(
      `https://host.example/webhooks/plugins/${CHANNEL_ID}/events-linq/`,
    );
  });

  test("carries no query at all", async () => {
    // Both providers sign their deliveries, so nothing secret belongs in the
    // URL — it would sit in a provider dashboard and in every access log
    // between there and here.
    writeConfig({ ingress: { publicBaseUrl: "https://host.example" } });

    for (const provider of ["photon", "comms", "linq"] as const) {
      const endpoint = await resolveWebhookEndpoint(provider);
      expect(endpoint.ok && endpoint.url).not.toContain("?");
    }
  });

  test("does not double the slash on a base that ends in one", async () => {
    // A pasted base URL keeps its trailing slash more often than not, and the
    // gateway matches the declared path exactly — `//events` is a 404.
    writeConfig({ ingress: { publicBaseUrl: "https://host.example/" } });
    const endpoint = await resolveWebhookEndpoint("comms");

    expect(endpoint.ok && endpoint.url).toContain("example/webhooks/");
  });

  test("reports a reason rather than guessing when no base is configured", async () => {
    // Registering a wrong URL is worse than registering none: the provider
    // then reports a healthy webhook pointing nowhere.
    writeConfig({ ingress: { publicBaseUrl: "" } });
    const endpoint = await resolveWebhookEndpoint("comms");

    expect(endpoint.ok).toBe(false);
    if (!endpoint.ok) expect(endpoint.reason).toContain("publicBaseUrl");
  });

  test("an absent config is the same answer as an unset base", async () => {
    expect((await resolveWebhookEndpoint("comms")).ok).toBe(false);
  });

  test("an unparsable config does not throw", async () => {
    writeFileSync(join(workspace, "config.json"), "{ not json", "utf-8");
    const endpoint = await resolveWebhookEndpoint("comms");
    expect(endpoint.ok).toBe(false);
  });
});

describe("with a host that resolves plugin webhook URLs", () => {
  /**
   * The path that matters. Reading `ingress.publicBaseUrl` cannot tell a
   * self-hosted tunnel from a Velay one, so on a platform-connected assistant
   * it produces a URL that is reachable and wrong — a webhook that registers
   * cleanly and receives nothing. The host knows which tier applies; this
   * plugin must not guess.
   */
  test("prefers the host's answer over the configured base", async () => {
    // A Velay URL in config, and the host resolving a managed callback route:
    // the managed one has to win, or every delivery goes to the tunnel.
    writeConfig({ ingress: { publicBaseUrl: "https://velay.example" } });
    const seen: { plugin: string; path: string }[] = [];

    const endpoint = await resolveWebhookEndpoint("photon", async (opts) => {
      seen.push({ plugin: opts.plugin, path: opts.path });
      return `https://callbacks.vellum.ai/abc/webhooks/plugins/imessage/${opts.path}`;
    });

    expect(endpoint.ok).toBe(true);
    if (endpoint.ok) {
      expect(endpoint.url).toBe(
        "https://callbacks.vellum.ai/abc/webhooks/plugins/imessage/events-photon/",
      );
    }
    expect(seen).toEqual([{ plugin: CHANNEL_ID, path: "events-photon" }]);
  });

  test("hands the vendor a URL with a trailing slash", async () => {
    // Vellum's managed callback layer 301s a slashless POST onto this
    // spelling, and following that redirect 404s before HMAC. The gateway
    // already serves both; registering the canonical one is what keeps the
    // vendor from walking the redirect. A host that still strips the slash
    // is corrected here.
    const endpoint = await resolveWebhookEndpoint(
      "comms",
      async (opts) =>
        `https://callbacks.vellum.ai/abc/webhooks/plugins/imessage/${opts.path}`,
    );

    expect(endpoint.ok && endpoint.url).toBe(
      "https://callbacks.vellum.ai/abc/webhooks/plugins/imessage/events-comms/",
    );
  });

  test("reports the host's reason rather than falling back to config", async () => {
    // No ingress and no platform connection means there is no URL that works.
    // Quietly composing one from config would put back the bug this replaces.
    writeConfig({ ingress: { publicBaseUrl: "https://velay.example" } });

    const endpoint = await resolveWebhookEndpoint("comms", () => {
      throw new Error("Public ingress URL is not configured");
    });

    expect(endpoint.ok).toBe(false);
    if (!endpoint.ok) {
      expect(endpoint.reason).toBe("Public ingress URL is not configured");
    }
  });
});
