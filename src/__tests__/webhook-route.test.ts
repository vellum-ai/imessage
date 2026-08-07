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

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { handleProviderWebhook } from "../webhook-route.ts";
import { IMessageConfigSchema } from "../config.ts";
import { resetPluginState, setConfig } from "../plugin-state.ts";

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
  test("answers a delivery with the message the gateway will admit", async () => {
    // The reply is the handoff. `channels/ingress.json` declares `inbound` on
    // this route, so what comes back here is what runs through the kill
    // switch, trust classification, and the admission floor.
    setConfig(IMessageConfigSchema.parse({ provider: "comms" }));
    const response = await handleProviderWebhook("comms", post(commsDelivery()));

    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toMatchObject({
      version: "v1",
      message: {
        content: "hello",
        conversationExternalId: "+15551234567",
        externalMessageId: "msg_01",
      },
      actor: { actorExternalId: "+15551234567" },
      source: { chatType: "imessage" },
    });
  });

  test("carries the vendor payload forward on the reply", async () => {
    // The gateway understands only the fields the manifest declares, so
    // anything the vendor sent beyond them survives on `raw` or nowhere.
    setConfig(IMessageConfigSchema.parse({ provider: "comms" }));
    const response = await handleProviderWebhook("comms", post(commsDelivery()));

    // The unwrapped message, which is what `normalizeCommsMessage` is handed —
    // the envelope is the transport, the message is the payload.
    expect(await bodyOf(response)).toMatchObject({
      raw: { id: "msg_01", channel: "imessage", direction: "inbound" },
    });
  });

  test("ignores a delivery on a provider that is not configured", async () => {
    // A registration left behind after switching providers. 200 rather than an
    // error: the delivery is authentic and retrying changes nothing, and a 4xx
    // would have the provider retry or disable a webhook whose only problem is
    // that it is stale.
    setConfig(IMessageConfigSchema.parse({ provider: "photon" }));
    const response = await handleProviderWebhook("comms", post(commsDelivery()));

    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toMatchObject({
      ignored: "provider is not configured",
    });
  });

  test("reads the payload with the route's own adapter", async () => {
    // A Comms envelope means nothing to the Photon normalizer. Binding the
    // normalizer to the path is what stops a delivery being read by an adapter
    // that cannot parse it.
    setConfig(IMessageConfigSchema.parse({ provider: "photon" }));
    const response = await handleProviderWebhook(
      "photon",
      post(commsDelivery()),
    );

    expect(await bodyOf(response)).toMatchObject({
      ignored: "not an inbound message",
    });
  });

  test("an outbound echo is not a turn", async () => {
    setConfig(IMessageConfigSchema.parse({ provider: "comms" }));
    const delivery = commsDelivery();
    delivery.message.direction = "outbound";

    expect(await bodyOf(await handleProviderWebhook("comms", post(delivery))))
      .toMatchObject({ ignored: "not an inbound message" });
  });

  test("forwards every inbound message, filtering none by sender", async () => {
    // The plugin no longer decides who may reach the assistant. That belongs
    // to the host's inbound pipeline, which classifies the actor against the
    // gateway's contact ACL; a second list here could only disagree with it.
    setConfig(IMessageConfigSchema.parse({ provider: "comms" }));

    const body = await bodyOf(
      await handleProviderWebhook("comms", post(commsDelivery())),
    );
    expect(body).toHaveProperty("actor");
    expect(body).not.toHaveProperty("ignored");
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
    expect(await bodyOf(response)).toMatchObject({ ignored: "unparsable body" });
  });

  test("poll mode leaves no live webhook surface", async () => {
    // An approved declaration the deployment does not use should not answer.
    setConfig(IMessageConfigSchema.parse({ ingressMode: "poll" }));
    const response = await handleProviderWebhook("comms", post(commsDelivery()));

    expect(response.status).toBe(404);
  });

  test("an unloaded plugin reports 503 rather than dropping the delivery", async () => {
    // 503 invites the provider's retry; a 200 would tell it the message landed.
    const response = await handleProviderWebhook("comms", post(commsDelivery()));
    expect(response.status).toBe(503);
  });
});
