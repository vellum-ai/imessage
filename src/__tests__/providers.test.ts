/**
 * Provider adapter tests.
 *
 * `resolveCredential` is mocked at the module level so the adapter and its
 * client resolve a key without reaching the host; `fetch` is stubbed per test so
 * no request leaves the process.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const realPluginApi = await import("@vellumai/plugin-api");

let credentialMode: "throw" | "value" = "value";
let credentialValue = "test-key";
let lastRef: string | null = null;

mock.module("@vellumai/plugin-api", () => ({
  ...realPluginApi,
  resolveCredential: mock(async (ref: string) => {
    lastRef = ref;
    if (credentialMode === "throw") throw new Error("credential not found");
    return credentialValue;
  }),
}));

const { createCommsProvider } = await import("../providers/comms/adapter.ts");
const { COMMS_API_BASE } = await import("../providers/comms/client.ts");
const { PROVIDER_IDS } = await import("../providers/types.ts");
const { resolveProvider } = await import("../providers/index.ts");
const { IMessageConfigSchema } = await import("../config.ts");

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

interface FetchCall {
  path: string;
  init: RequestInit;
}

const originalFetch = globalThis.fetch;
let calls: FetchCall[] = [];

function stubFetch(handler: (call: FetchCall) => Response): void {
  globalThis.fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    const call = {
      path: String(url).replace(COMMS_API_BASE, ""),
      init: init ?? {},
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
}

beforeEach(() => {
  calls = [];
  credentialMode = "value";
  credentialValue = "test-key";
  lastRef = null;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("provider registry", () => {
  test("comms is the only provider", () => {
    // Bring-your-own is the whole product; a Vellum-hosted line is priced per
    // line by every vendor that sells one.
    expect(PROVIDER_IDS).toEqual(["comms"]);
  });

  test("builds the comms provider from config", () => {
    const config = IMessageConfigSchema.parse({});
    expect(resolveProvider({ config }).id).toBe("comms");
  });
});

describe("comms provider", () => {
  test("resolves the fixed imessage/api_key credential", async () => {
    await createCommsProvider().checkReadiness();
    expect(lastRef).toBe("imessage/api_key");
  });

  test("normalizes inside the adapter so the poller stays agnostic", async () => {
    stubFetch(() => Response.json({ messages: [commsMessage()] }));
    const records = await createCommsProvider().fetchInbound({ limit: 10 });

    expect(records).toHaveLength(1);
    expect(records[0]?.id).toBe("msg_01");
    expect(records[0]?.createdAt).toBe("2026-07-28T12:00:00.000Z");
    expect(records[0]?.event?.actor.actorExternalId).toBe("+15551234567");
  });

  test("a record that is not a turn still carries its id for the cursor", async () => {
    stubFetch(() =>
      Response.json({ messages: [commsMessage({ direction: "outbound" })] }),
    );
    const records = await createCommsProvider().fetchInbound({ limit: 10 });

    expect(records[0]?.id).toBe("msg_01");
    expect(records[0]?.event).toBeUndefined();
  });

  test("send forwards the idempotency key and bearer token", async () => {
    stubFetch(() =>
      Response.json({ message: { id: "msg_out", direction: "outbound" } }),
    );
    const result = await createCommsProvider().send(
      { to: "+15551234567" },
      "hi",
      { idempotencyKey: "abc123" },
    );

    expect(result.id).toBe("msg_out");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe("abc123");
    expect(headers.Authorization).toBe("Bearer test-key");
  });

  test("forces the configured send channel", async () => {
    stubFetch(() =>
      Response.json({ message: { id: "m", direction: "outbound" } }),
    );
    await createCommsProvider({ sendChannel: "imessage" }).send(
      { to: "+15551234567" },
      "hi",
      { idempotencyKey: "k" },
    );

    expect(JSON.parse(String(calls[0]?.init.body)).channel).toBe("imessage");
  });

  test("readiness reports a missing key rather than throwing", async () => {
    credentialMode = "throw";
    const readiness = await createCommsProvider().checkReadiness();

    expect(readiness.ready).toBe(false);
    if (!readiness.ready) {
      expect(readiness.reason).toContain("credentials set");
    }
  });

  test("supports polling", () => {
    expect(createCommsProvider().supportsPolling).toBe(true);
  });
});
