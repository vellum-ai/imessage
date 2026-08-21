/**
 * The per-provider webhook handler.
 *
 * What matters here is that a delivery is read by the adapter belonging to the
 * *route* rather than the adapter belonging to whatever is configured. The two
 * agree in the normal case; the tests are about the cases where they do not.
 *
 * The gateway has already verified the delivery by the time any of this runs,
 * so nothing here checks a signature.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { handleProviderWebhook, resolveWebhookConfig } from "../webhook-route.ts";
import { IMessageConfigSchema } from "../config.ts";
import {
  getInboundProbe,
  resetPluginState,
  setConfig,
} from "../plugin-state.ts";

function post(body: unknown): Request {
  return new Request("http://localhost/x/plugins/imessage/events-comms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function commsDelivery() {
  return {
    event: "comms.message.received",
    message: {
      id: "msg_01",
      direction: "inbound",
      body: "hello",
      channel: "imessage",
      from: "+15551234567",
    },
  };
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

beforeEach(() => {
  resetPluginState();
});

afterEach(() => {
  resetPluginState();
});

describe("handleProviderWebhook", () => {
  test("ignores a delivery on a provider that is not configured", async () => {
    // A registration left behind after switching providers. 200 rather than an
    // error: the delivery is authentic and retrying changes nothing, and a 4xx
    // would have the provider retry or disable a webhook whose only problem is
    // that it is stale.
    setConfig(
      IMessageConfigSchema.parse({
        provider: "photon",
        ingressMode: "webhook",
      }),
    );
    const response = await handleProviderWebhook(
      "comms",
      post(commsDelivery()),
    );

    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toMatchObject({
      ignored: "provider is not configured",
    });
  });

  test("reads the payload with the route's own adapter", async () => {
    // A Comms envelope means nothing to the Photon normalizer. Binding the
    // normalizer to the path is what stops a delivery being read by an adapter
    // that cannot parse it.
    setConfig(
      IMessageConfigSchema.parse({
        provider: "photon",
        ingressMode: "webhook",
      }),
    );
    const response = await handleProviderWebhook(
      "photon",
      post(commsDelivery()),
    );

    expect(await bodyOf(response)).toMatchObject({
      ignored: "not an inbound message",
    });
  });

  test("recognizes the vendor's delivery test as a probe, not a failure", async () => {
    // `POST /webhooks/{id}/test` sends a signed `comms.ping` through the real
    // pipeline, so one arriving proves registration, the signing secret and
    // the gateway route all work. Reporting it as "not an inbound message"
    // made the one available proof of delivery read exactly like a failure.
    setConfig(IMessageConfigSchema.parse({ provider: "comms" }));
    const response = await handleProviderWebhook(
      "comms",
      post({ event: "comms.ping" }),
    );

    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual({ ok: true, probe: "comms.ping" });
  });

  test("records the probe so silent inbound is answerable without a text", async () => {
    setConfig(IMessageConfigSchema.parse({ provider: "comms" }));
    await handleProviderWebhook("comms", post({ event: "comms.ping" }));

    const probe = getInboundProbe();
    expect(probe?.provider).toBe("comms");
    expect(probe?.label).toBe("comms.ping");
    expect(probe?.at.length ?? 0).toBeGreaterThan(0);
  });

  test("a probe never becomes a turn", async () => {
    // It carries no sender and no content. Anything that treated it as a
    // message would be inventing both.
    setConfig(IMessageConfigSchema.parse({ provider: "comms" }));
    const body = await bodyOf(
      await handleProviderWebhook("comms", post({ event: "comms.ping" })),
    );

    expect(body).not.toHaveProperty("actor");
    expect(body).not.toHaveProperty("message");
  });

  test("names the event it declined rather than the category", async () => {
    // A vendor that starts sending something new should be visible in the
    // reply, not folded into one catch-all sentence.
    setConfig(IMessageConfigSchema.parse({ provider: "comms" }));
    const body = await bodyOf(
      await handleProviderWebhook("comms", post({ event: "comms.receipt" })),
    );

    expect(body.ignored).toBe("comms.receipt is not an inbound message");
  });

  test("an outbound echo is not a turn", async () => {
    setConfig(IMessageConfigSchema.parse({ provider: "comms" }));
    const delivery = commsDelivery();
    delivery.message.direction = "outbound";

    expect(
      await bodyOf(await handleProviderWebhook("comms", post(delivery))),
    ).toMatchObject({
      ignored: "comms.message.received is not an inbound message",
    });
  });

  test("an unparsable body is acknowledged, not retried", async () => {
    setConfig(IMessageConfigSchema.parse({ provider: "comms" }));
    const request = new Request("http://localhost/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not json",
    });

    const response = await handleProviderWebhook("comms", request);
    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toMatchObject({
      ignored: "unparsable body",
    });
  });

  test("poll mode leaves no live webhook surface", async () => {
    // An approved declaration the deployment does not use should not answer.
    setConfig(IMessageConfigSchema.parse({ ingressMode: "poll" }));
    const response = await handleProviderWebhook(
      "comms",
      post(commsDelivery()),
    );

    expect(response.status).toBe(404);
  });

  test("live mode leaves no live webhook surface", async () => {
    setConfig(IMessageConfigSchema.parse({ ingressMode: "live" }));
    const response = await handleProviderWebhook(
      "photon",
      post(commsDelivery()),
    );

    expect(response.status).toBe(404);
  });

  test("empty in-memory state does not 503 a delivery", async () => {
    // The host loads this route with `file.ts?t=mtime`, a different module
    // instance than the one `init` populated. `getConfig()` is empty here
    // even when the plugin is up. A 503 was the bug: comms.ping retried
    // forever as "plugin not initialized". Durable config / defaults answer
    // instead (404 when webhook ingress is off, 200 when it is on).
    const response = await handleProviderWebhook(
      "comms",
      post({ event: "comms.ping" }),
    );
    expect(response.status).not.toBe(503);
    expect(response.status).toBeGreaterThanOrEqual(200);
    expect(response.status).toBeLessThan(500);
  });
});

describe("resolveWebhookConfig", () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "imessage-webhook-config-"));
    configPath = join(dir, "config.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("reads provider and ingress from disk when this instance never saw init", () => {
    writeFileSync(configPath, JSON.stringify({ provider: "comms" }), "utf-8");

    const config = resolveWebhookConfig(configPath);

    expect(config.provider).toBe("comms");
    // Comms has no live stream, so the live default is webhook.
    expect(config.ingressMode).toBe("webhook");
  });

  test("a comms ping answers from durable config when memory is empty", async () => {
    writeFileSync(configPath, JSON.stringify({ provider: "comms" }), "utf-8");

    const response = await handleProviderWebhook(
      "comms",
      post({ event: "comms.ping" }),
      configPath,
    );

    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual({ ok: true, probe: "comms.ping" });
  });

  test("in-memory config wins over the durable file", () => {
    writeFileSync(configPath, JSON.stringify({ provider: "comms" }), "utf-8");
    setConfig(
      IMessageConfigSchema.parse({
        provider: "photon",
        ingressMode: "webhook",
      }),
    );

    expect(resolveWebhookConfig(configPath)).toMatchObject({
      provider: "photon",
      ingressMode: "webhook",
    });
  });
});
