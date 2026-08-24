/**
 * Linq adapter tests.
 *
 * `resolveCredential` is mocked at the module level so the adapter and its
 * client resolve a token without reaching the host; `fetch` is stubbed per
 * test so no request leaves the process.
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
    if (credentialMode === "throw") {
      throw new Error("credential not found");
    }
    return credentialValue;
  }),
}));

const { createLinqProvider } = await import("../providers/linq/adapter.ts");
const { LINQ_API_BASE } = await import("../providers/linq/client.ts");
const { classifyLinqWebhook, normalizeLinqMessage } = await import(
  "../providers/linq/normalize.ts"
);
const { LINQ_WEBHOOK_VERSION, withLinqWebhookVersion } = await import(
  "../providers/linq/schemas.ts"
);

function linqMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg_01",
    chat_id: "chat_abc",
    direction: "inbound",
    is_from_me: false,
    parts: [{ type: "text", value: "hello" }],
    sender_handle: { handle: "+15551234567", service: "iMessage" },
    service: "iMessage",
    created_at: "2026-07-28T12:00:00.000Z",
    ...overrides,
  };
}

function linqWebhook(overrides: Record<string, unknown> = {}) {
  return {
    api_version: "v3",
    webhook_version: LINQ_WEBHOOK_VERSION,
    event_type: "message.received",
    event_id: "evt_01",
    data: {
      id: "msg_01",
      direction: "inbound",
      chat: { id: "chat_abc" },
      sender_handle: { handle: "+15551234567", service: "iMessage" },
      parts: [{ type: "text", value: "hello" }],
      service: "iMessage",
      ...overrides,
    },
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
      path: String(url).replace(LINQ_API_BASE, ""),
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

describe("linq provider", () => {
  test("resolves the fixed imessage/linq_api_key credential", async () => {
    stubFetch(() =>
      Response.json({ phone_numbers: [{ phone_number: "+15550100" }] }),
    );
    await createLinqProvider().checkReadiness();
    expect(lastRef).toBe("imessage/linq_api_key");
  });

  test("readiness proves the token against the phone-numbers list", async () => {
    stubFetch(() =>
      Response.json({ phone_numbers: [{ phone_number: "+15550100" }] }),
    );

    expect((await createLinqProvider().checkReadiness()).ready).toBe(true);
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-key");
    expect(calls[0]?.path).toBe("/phone_numbers");
  });

  test("an account with no line is not ready", async () => {
    stubFetch(() => Response.json({ phone_numbers: [] }));
    const readiness = await createLinqProvider().checkReadiness();

    expect(readiness.ready).toBe(false);
    if (!readiness.ready) {
      expect(readiness.reason).toContain("no phone numbers");
    }
  });

  test("readiness reports a missing token rather than throwing", async () => {
    credentialMode = "throw";
    const readiness = await createLinqProvider().checkReadiness();

    expect(readiness.ready).toBe(false);
    if (!readiness.ready) {
      expect(readiness.reason).toContain("Linq API token");
      expect(readiness.reason).toContain("could not be read");
    }
  });

  test("normalizes inside the adapter so the poller stays agnostic", async () => {
    stubFetch((call) => {
      if (call.path.startsWith("/chats?") || call.path === "/chats") {
        return Response.json({ chats: [{ id: "chat_abc" }] });
      }
      return Response.json({ messages: [linqMessage()] });
    });
    const records = await createLinqProvider().fetchInbound({ limit: 10 });

    expect(records).toHaveLength(1);
    expect(records[0]?.id).toBe("msg_01");
    expect(records[0]?.createdAt).toBe("2026-07-28T12:00:00.000Z");
    expect(records[0]?.event?.actor.actorExternalId).toBe("+15551234567");
    expect(records[0]?.event?.message.conversationExternalId).toBe("chat_abc");
  });

  test("a record that is not a turn still carries its id for the cursor", async () => {
    stubFetch((call) => {
      if (call.path.startsWith("/chats?") || call.path === "/chats") {
        return Response.json({ chats: [{ id: "chat_abc" }] });
      }
      return Response.json({
        messages: [linqMessage({ is_from_me: true, direction: "outbound" })],
      });
    });
    const records = await createLinqProvider().fetchInbound({ limit: 10 });

    expect(records[0]?.id).toBe("msg_01");
    expect(records[0]?.event).toBeUndefined();
  });

  test("a failed send reports what Linq said, not just the status", async () => {
    stubFetch(() =>
      Response.json(
        { error: { message: "You cannot send from this phone number" } },
        { status: 403 },
      ),
    );

    await expect(
      createLinqProvider().send({ to: "+15551234567" }, "hi", {
        idempotencyKey: "k1",
      }),
    ).rejects.toThrow("403 — You cannot send from this phone number");
  });

  test("a cold send lets Linq pick the line", async () => {
    stubFetch(() =>
      Response.json({
        chat_id: "chat_new",
        message: { id: "msg_out", direction: "outbound" },
      }),
    );
    const result = await createLinqProvider().send(
      { to: "+15551234567" },
      "hi",
      { idempotencyKey: "abc123" },
    );

    expect(result.id).toBe("msg_out");
    expect(calls[0]?.path).toBe("/messages");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      to: ["+15551234567"],
      message: {
        parts: [{ type: "text", value: "hi" }],
        idempotency_key: "abc123",
      },
    });
    expect(JSON.parse(String(calls[0]?.init.body))).not.toHaveProperty("from");
  });

  test("a reply to a known chat posts into that chat", async () => {
    stubFetch(() =>
      Response.json({ message: { id: "msg_out", direction: "outbound" } }),
    );
    await createLinqProvider().send(
      { conversationId: "chat_abc" },
      "hi",
      { idempotencyKey: "k" },
    );

    expect(calls[0]?.path).toBe("/chats/chat_abc/messages");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      message: {
        parts: [{ type: "text", value: "hi" }],
        idempotency_key: "k",
      },
    });
  });

  test("typing uses a chat id without creating a chat", async () => {
    stubFetch(() => new Response(null, { status: 204 }));
    const provider = createLinqProvider();

    await provider.setTyping?.({ conversationId: "chat_abc" }, true);
    await provider.setTyping?.({ conversationId: "chat_abc" }, false);

    expect(calls.map((c) => `${c.init.method} ${c.path}`)).toEqual([
      "POST /chats/chat_abc/typing",
      "DELETE /chats/chat_abc/typing",
    ]);
  });

  test("typing on an unknown handle creates nothing", async () => {
    stubFetch(() => new Response(null, { status: 204 }));

    await createLinqProvider().setTyping?.({ to: "+15551234567" }, true);

    expect(calls).toEqual([]);
  });

  test("supports polling and not live ingress", () => {
    expect(createLinqProvider().supportsPolling).toBe(true);
    expect(createLinqProvider().supportsLive).toBe(false);
    expect(createLinqProvider().subscribeInbound).toBeUndefined();
  });

  test("does not restrict recipients", () => {
    expect(createLinqProvider().allowRecipient).toBeUndefined();
  });
});

describe("linq webhook registration", () => {
  test("registers for message.received and keeps the issued secret", async () => {
    stubFetch((call) =>
      call.init.method === "GET"
        ? Response.json({ subscriptions: [] })
        : Response.json({
            id: "sub_1",
            target_url: "https://host.example/events-linq/?version=2026-02-03",
            signing_secret: "whsec_abc",
          }),
    );

    const result = await createLinqProvider().ensureWebhook({
      url: "https://host.example/events-linq/",
      hasSecret: false,
    });

    expect(result).toEqual({
      created: true,
      id: "sub_1",
      secret: "whsec_abc",
    });
    expect(calls.map((c) => c.init.method)).toEqual(["GET", "POST"]);
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({
      target_url: withLinqWebhookVersion("https://host.example/events-linq/"),
      subscribed_events: ["message.received"],
    });
  });

  test("does not re-register when the secret is already held", async () => {
    stubFetch((call) =>
      call.init.method === "GET"
        ? Response.json({
            subscriptions: [
              {
                id: "sub_2",
                target_url: withLinqWebhookVersion(
                  "https://host.example/events-linq/",
                ),
                subscribed_events: ["message.received"],
                is_active: true,
              },
            ],
          })
        : Response.json({}),
    );

    const result = await createLinqProvider().ensureWebhook({
      url: "https://host.example/events-linq/",
      hasSecret: true,
    });

    expect(result).toEqual({ created: false, id: "sub_2" });
    expect(calls).toHaveLength(1);
  });

  test("updates events on an existing registration when the secret is held", async () => {
    stubFetch((call) => {
      if (call.init.method === "GET") {
        return Response.json({
          subscriptions: [
            {
              id: "sub_2",
              target_url: withLinqWebhookVersion(
                "https://host.example/events-linq/",
              ),
              subscribed_events: ["message.sent"],
              is_active: true,
            },
          ],
        });
      }
      expect(call.init.method).toBe("PUT");
      expect(call.path).toBe("/webhook-subscriptions/sub_2");
      return Response.json({ id: "sub_2" });
    });

    const result = await createLinqProvider().ensureWebhook({
      url: "https://host.example/events-linq/",
      hasSecret: true,
    });

    expect(result).toEqual({ created: false, id: "sub_2" });
    expect(calls.map((c) => c.init.method)).toEqual(["GET", "PUT"]);
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({
      target_url: withLinqWebhookVersion("https://host.example/events-linq/"),
      subscribed_events: ["message.received"],
    });
  });

  test("treats a versioned URL with or without a trailing slash as the same registration", async () => {
    const versioned = withLinqWebhookVersion(
      "https://host.example/events-linq/",
    );
    const slashless = versioned.replace("/?version=", "?version=");
    stubFetch(() =>
      Response.json({
        subscriptions: [
          {
            id: "sub_slash",
            target_url: slashless,
            subscribed_events: ["message.received"],
            is_active: true,
          },
        ],
      }),
    );

    const result = await createLinqProvider().ensureWebhook({
      url: "https://host.example/events-linq/",
      hasSecret: true,
    });

    expect(result).toEqual({ created: false, id: "sub_slash" });
    expect(calls).toHaveLength(1);
  });

  test("replaces a registration when the signing secret was lost", async () => {
    stubFetch((call) => {
      if (call.init.method === "GET") {
        return Response.json({
          subscriptions: [
            {
              id: "sub_old",
              target_url: withLinqWebhookVersion(
                "https://host.example/events-linq/",
              ),
              subscribed_events: ["message.received"],
            },
          ],
        });
      }
      if (call.init.method === "DELETE") {
        expect(call.path).toBe("/webhook-subscriptions/sub_old");
        return new Response(null, { status: 204 });
      }
      return Response.json({
        id: "sub_new",
        signing_secret: "whsec_new",
      });
    });

    const result = await createLinqProvider().ensureWebhook({
      url: "https://host.example/events-linq/",
      hasSecret: false,
    });

    expect(result).toEqual({
      created: true,
      id: "sub_new",
      secret: "whsec_new",
    });
    expect(calls.map((c) => c.init.method)).toEqual(["GET", "DELETE", "POST"]);
  });
});

describe("linq normalize", () => {
  const receivedAt = "2026-07-28T12:00:30.000Z";

  test("maps the documented 2026-02-03 webhook delivery", () => {
    const delivery = classifyLinqWebhook(linqWebhook(), receivedAt);

    expect(delivery.kind).toBe("message");
    if (delivery.kind !== "message") {
      return;
    }
    expect(delivery.event.actor.actorExternalId).toBe("+15551234567");
    expect(delivery.event.message.conversationExternalId).toBe("chat_abc");
    expect(delivery.event.message.content).toBe("hello");
    expect(delivery.event.source.chatType).toBe("imessage");
    expect(delivery.event.receivedAt).toBe(receivedAt);
  });

  test("maps the 2025-01-01 webhook envelope as a fallback", () => {
    const delivery = classifyLinqWebhook(
      {
        event_type: "message.received",
        data: {
          chat_id: "chat_abc",
          from: "+15551234567",
          is_from_me: false,
          service: "iMessage",
          message: {
            id: "msg_legacy",
            parts: [{ type: "text", value: "hey" }],
          },
        },
      },
      receivedAt,
    );

    expect(delivery.kind).toBe("message");
    if (delivery.kind !== "message") {
      return;
    }
    expect(delivery.event.message.externalMessageId).toBe("msg_legacy");
    expect(delivery.event.message.content).toBe("hey");
    expect(delivery.event.actor.actorExternalId).toBe("+15551234567");
  });

  test("an outbound echo is never a turn", () => {
    const delivery = classifyLinqWebhook(
      linqWebhook({ direction: "outbound" }),
      receivedAt,
    );
    expect(delivery.kind).toBe("ignored");
  });

  test("a receipt is ignored rather than turned", () => {
    const delivery = classifyLinqWebhook(
      { event_type: "message.delivered", data: { id: "msg_01" } },
      receivedAt,
    );
    expect(delivery).toEqual({
      kind: "ignored",
      reason: "message.delivered is not an inbound message",
    });
  });

  test("an unattributable delivery is dropped rather than guessed at", () => {
    expect(
      normalizeLinqMessage(
        linqMessage({ sender_handle: { handle: "not-a-number" }, from: undefined }),
        receivedAt,
      ),
    ).toBeUndefined();
  });

  test("SMS reads as sms, the conservative chat type", () => {
    const event = normalizeLinqMessage(
      linqMessage({ service: "SMS" }),
      receivedAt,
    );
    expect(event?.source.chatType).toBe("sms");
  });

  test("joins multiple text parts", () => {
    const event = normalizeLinqMessage(
      linqMessage({
        parts: [
          { type: "text", value: "one" },
          { type: "media", value: "" },
          { type: "text", value: "two" },
        ],
      }),
      receivedAt,
    );
    expect(event?.message.content).toBe("one\ntwo");
  });
});
