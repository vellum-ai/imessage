import { describe, expect, test } from "bun:test";

import { createCommsProvider } from "../providers/comms/adapter.ts";
import { CommsClient } from "../providers/comms/client.ts";
import { createVellumProvider } from "../providers/vellum/adapter.ts";
import { PROVIDER_IDS } from "../providers/types.ts";

function commsMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg_01",
    direction: "inbound",
    body: "hello",
    channel: "imessage",
    conversation_id: "conv_abc",
    from: "+15551234567",
    created_at: "2026-07-28T12:00:00.000Z",
    ...overrides,
  };
}

/** CommsClient with a stubbed transport, so no network is touched. */
function stubbedCommsClient(handler: (path: string, init: RequestInit) => Response) {
  const calls: { path: string; init: RequestInit }[] = [];
  const client = new CommsClient(
    async () => "test-key",
    "https://stub.invalid",
  );
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace("https://stub.invalid", "");
    calls.push({ path, init: init ?? {} });
    return handler(path, init ?? {});
  }) as typeof fetch;
  return { client, calls, restore: () => void (globalThis.fetch = original) };
}

describe("provider registry", () => {
  test("vellum is one of the known ids", () => {
    expect(PROVIDER_IDS).toContain("vellum");
    expect(PROVIDER_IDS).toContain("comms");
  });
});

describe("comms provider", () => {
  test("normalizes inside the adapter so the poller stays agnostic", async () => {
    const { client, restore } = stubbedCommsClient(() =>
      Response.json({ messages: [commsMessage()] }),
    );
    try {
      const provider = createCommsProvider({
        getApiKey: async () => "test-key",
        client,
      });
      const records = await provider.fetchInbound({ limit: 10 });

      expect(records).toHaveLength(1);
      expect(records[0]?.id).toBe("msg_01");
      expect(records[0]?.createdAt).toBe("2026-07-28T12:00:00.000Z");
      expect(records[0]?.event?.actor.actorExternalId).toBe("+15551234567");
    } finally {
      restore();
    }
  });

  test("a record that is not a turn still carries its id for the cursor", async () => {
    const { client, restore } = stubbedCommsClient(() =>
      Response.json({ messages: [commsMessage({ direction: "outbound" })] }),
    );
    try {
      const provider = createCommsProvider({
        getApiKey: async () => "k",
        client,
      });
      const records = await provider.fetchInbound({ limit: 10 });

      expect(records[0]?.id).toBe("msg_01");
      expect(records[0]?.event).toBeUndefined();
    } finally {
      restore();
    }
  });

  test("send forwards the idempotency key", async () => {
    const { client, calls, restore } = stubbedCommsClient(() =>
      Response.json({ message: { id: "msg_out", direction: "outbound" } }),
    );
    try {
      const provider = createCommsProvider({
        getApiKey: async () => "k",
        client,
      });
      const result = await provider.send({ to: "+15551234567" }, "hi", {
        idempotencyKey: "abc123",
      });

      expect(result.id).toBe("msg_out");
      const headers = calls[0]?.init.headers as Record<string, string>;
      expect(headers["Idempotency-Key"]).toBe("abc123");
    } finally {
      restore();
    }
  });

  test("readiness reports a missing key rather than throwing", async () => {
    const provider = createCommsProvider({
      getApiKey: async () => {
        throw new Error("Comms API key not found.");
      },
    });
    const readiness = await provider.checkReadiness();
    expect(readiness.ready).toBe(false);
  });

  test("supports polling", () => {
    const provider = createCommsProvider({ getApiKey: async () => "k" });
    expect(provider.supportsPolling).toBe(true);
  });
});

describe("vellum provider", () => {
  test("is webhook-only", async () => {
    const provider = createVellumProvider({
      platformFetch: async () => Response.json({}),
    });
    expect(provider.supportsPolling).toBe(false);
    await expect(provider.fetchInbound({ limit: 10 })).rejects.toThrow(
      /webhook-only/,
    );
  });

  test("reports an unprovisioned line as not ready", async () => {
    const provider = createVellumProvider({
      platformFetch: async () => Response.json({ count: 0, results: [] }),
    });
    const readiness = await provider.checkReadiness();
    expect(readiness.ready).toBe(false);
    if (!readiness.ready) {
      expect(readiness.reason).toContain("no iMessage line");
    }
  });

  test("reports a provisioned line as ready", async () => {
    const provider = createVellumProvider({
      platformFetch: async () =>
        Response.json({ count: 1, results: [{ id: "line_1" }] }),
    });
    expect((await provider.checkReadiness()).ready).toBe(true);
  });

  test("a platform error is a reason, not a throw", async () => {
    const provider = createVellumProvider({
      platformFetch: async () => {
        throw new Error("network down");
      },
    });
    const readiness = await provider.checkReadiness();
    expect(readiness.ready).toBe(false);
  });

  test("send carries the idempotency key and surfaces failures", async () => {
    let seen: RequestInit | undefined;
    const ok = createVellumProvider({
      platformFetch: async (_path, init) => {
        seen = init;
        return Response.json({ message: { id: "msg_p" } });
      },
    });
    const result = await ok.send({ to: "+15551234567" }, "hi", {
      idempotencyKey: "k1",
    });
    expect(result.id).toBe("msg_p");
    expect((seen?.headers as Record<string, string>)["Idempotency-Key"]).toBe(
      "k1",
    );

    const failing = createVellumProvider({
      platformFetch: async () => new Response("nope", { status: 502 }),
    });
    await expect(
      failing.send({ to: "+1555" }, "hi", { idempotencyKey: "k2" }),
    ).rejects.toThrow(/502/);
  });

  test("normalizes the same wire shape as comms", () => {
    // The platform runs Comms underneath and forwards the provider event, so
    // a divergence here would mean messages silently not becoming turns.
    const provider = createVellumProvider({
      platformFetch: async () => Response.json({}),
    });
    const event = provider.normalizeWebhook(
      { event: "message.received", message: commsMessage() },
      "2026-07-28T12:00:30.000Z",
    );
    expect(event?.actor.actorExternalId).toBe("+15551234567");
  });
});
