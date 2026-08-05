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
const { createPhotonProvider } = await import("../providers/photon/adapter.ts");
const { PHOTON_CLOUD_BASE, PHOTON_IMESSAGE_BASE } = await import(
  "../providers/photon/client.ts"
);
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
  test("photon is the default", () => {
    // Bring-your-own is the shipping path either way; Photon is the more
    // mature of the two lines.
    const config = IMessageConfigSchema.parse({});
    expect(config.provider).toBe("photon");
    expect(resolveProvider({ config }).id).toBe("photon");
  });

  test("knows both providers", () => {
    expect(PROVIDER_IDS).toContain("comms");
    expect(PROVIDER_IDS).toContain("photon");
  });

  test("builds photon from config alone", () => {
    // Nothing is injected and nothing is resolved at build time: an
    // unconfigured line has to cost nothing at boot, so a missing credential
    // surfaces from checkReadiness rather than from a provider that refuses
    // to exist.
    const config = IMessageConfigSchema.parse({ provider: "photon" });
    expect(resolveProvider({ config }).id).toBe("photon");
  });

  test("every provider id resolves to an adapter that claims it", () => {
    // A registry entry keyed by one id and returning another is the kind of
    // thing that only shows up as messages going out over the wrong line.
    for (const id of PROVIDER_IDS) {
      const config = IMessageConfigSchema.parse({ provider: id });
      expect(resolveProvider({ config }).id).toBe(id);
    }
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

  test("a failed send reports what Comms said, not just the status", async () => {
    stubFetch(() =>
      Response.json(
        { error: { message: "scope comms_send missing" } },
        { status: 403 },
      ),
    );

    await expect(
      createCommsProvider().send({ to: "+15551234567" }, "hi", {
        idempotencyKey: "k1",
      }),
    ).rejects.toThrow("403 — scope comms_send missing");
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

  test("leaves the delivery channel to Comms", async () => {
    // Comms picks iMessage where the handle supports it and falls back to SMS,
    // per recipient. Naming a channel would override that for every message.
    stubFetch(() =>
      Response.json({ message: { id: "m", direction: "outbound" } }),
    );
    await createCommsProvider().send({ to: "+15551234567" }, "hi", {
      idempotencyKey: "k",
    });

    expect(JSON.parse(String(calls[0]?.init.body))).not.toHaveProperty(
      "channel",
    );
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


/**
 * Photon fixtures.
 *
 * Photon answers on two hosts — a control plane that mints tokens and a
 * message plane that uses them — so these route on the URL rather than
 * stubbing one endpoint. `credentialValue` stands in for both the project id
 * and the project secret, which is why the Basic header below is that value
 * twice.
 */
const SHARED_TOKEN = {
  succeed: true,
  data: { type: "shared", token: "tok_live", expiresIn: 600 },
};

function stubPhoton(handler: (call: FetchCall) => Response | undefined): void {
  stubFetch((call) => {
    const answered = handler(call);
    if (answered) return answered;
    if (call.path.includes("/imessage/tokens")) {
      return Response.json(SHARED_TOKEN);
    }
    return Response.json({ succeed: true, data: {} });
  });
}

function photonMessage(overrides: Record<string, unknown> = {}) {
  return {
    guid: "p2p-A1",
    isFromMe: false,
    dateCreated: "2026-07-28T12:00:00.000Z",
    chatGuids: ["any;-;+15551234567"],
    sender: { address: "+15551234567", service: "iMessage" },
    content: { text: "hello" },
    ...overrides,
  };
}

/** The documented `messages` webhook delivery. */
function photonWebhook(overrides: Record<string, unknown> = {}) {
  return {
    event: "messages",
    space: { id: "any;-;+15550100", platform: "iMessage", type: "dm" },
    message: {
      id: "spc-msg-1",
      platform: "iMessage",
      direction: "inbound",
      timestamp: "2026-07-28T12:00:00.000Z",
      sender: { id: "+15550100", platform: "iMessage" },
      space: { id: "any;-;+15550100", platform: "iMessage", type: "dm" },
      content: { type: "text", text: "hey, what time is dinner?" },
      ...overrides,
    },
  };
}

describe("photon provider", () => {
  test("readiness proves the credential pair, not just its presence", async () => {
    // Stopping at "both fields are stored" reports ready for a mistyped
    // project id, and the first symptom of that is a silently dead line.
    stubPhoton((call) =>
      call.path === `${PHOTON_CLOUD_BASE}/projects/test-key/`
        ? Response.json({ succeed: true, data: { name: "demo", slug: "demo" } })
        : undefined,
    );

    expect((await createPhotonProvider().checkReadiness()).ready).toBe(true);
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${btoa("test-key:test-key")}`);
  });

  test("a rejected envelope becomes a reason, not a throw", async () => {
    // Photon reports failure inside a 200 body, so status alone would read
    // this as success.
    stubPhoton(() =>
      Response.json({ succeed: false, message: "invalid credentials" }),
    );

    const readiness = await createPhotonProvider().checkReadiness();
    expect(readiness.ready).toBe(false);
    if (!readiness.ready) {
      expect(readiness.reason).toContain("invalid credentials");
    }
  });

  test("a missing credential is a reason naming the settings app", async () => {
    credentialMode = "throw";
    const readiness = await createPhotonProvider().checkReadiness();

    expect(readiness.ready).toBe(false);
    if (!readiness.ready) {
      expect(readiness.reason).toContain("Photon project ID");
      expect(readiness.reason).toContain("settings app");
    }
  });

  test("a failed send reports what Photon said, not just the status", async () => {
    // The failure that motivated this: a 415 on chat creation surfaced as
    // `failed: 415` and nothing else, so the only moves left were guesses —
    // re-check the credential, re-confirm the config, try another endpoint.
    // The provider's own sentence is what ends that.
    stubPhoton((call) =>
      call.path.includes("/v1/chats")
        ? Response.json({ message: "unsupported content type" }, { status: 415 })
        : undefined,
    );

    await expect(
      createPhotonProvider().send({ to: "+15551234567" }, "hi", {
        idempotencyKey: "k1",
      }),
    ).rejects.toThrow("415 — unsupported content type");
  });

  test("a reply to a known chat mints a token and sends to the guid", async () => {
    stubPhoton((call) =>
      call.path.includes("/v1/messages:sendText")
        ? Response.json({ message: { guid: "p2p-out", isFromMe: true } })
        : undefined,
    );

    const result = await createPhotonProvider().send(
      { conversationId: "any;-;+15551234567" },
      "hi",
      { idempotencyKey: "k1" },
    );

    expect(result.id).toBe("p2p-out");
    expect(calls[0]?.path).toBe(
      `${PHOTON_CLOUD_BASE}/projects/test-key/imessage/tokens`,
    );

    const send = calls[1];
    expect(send?.path).toBe(`${PHOTON_IMESSAGE_BASE}/v1/messages:sendText`);
    const headers = send?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok_live");
    expect(headers["x-idempotency-key"]).toBe("k1");
    expect(JSON.parse(String(send?.init.body))).toMatchObject({
      chatGuid: "any;-;+15551234567",
      text: "hi",
      clientMessageId: "k1",
    });
  });

  test("a cold send to a bare handle resolves the chat in the same call", async () => {
    // Photon addresses conversations by chat guid, so a raw handle needs one
    // resolved. Carrying the text along makes that one round trip, not two.
    stubPhoton((call) =>
      call.path.includes("/v1/chats")
        ? Response.json({
            chat: { guid: "any;-;+15551234567" },
            initialMessage: { guid: "p2p-first", isFromMe: true },
          })
        : undefined,
    );

    const result = await createPhotonProvider().send(
      { to: "+15551234567" },
      "hi",
      { idempotencyKey: "k2" },
    );

    expect(result.id).toBe("p2p-first");
    const body = JSON.parse(String(calls[1]?.init.body));
    expect(body.addresses).toEqual(["+15551234567"]);
    expect(body.initialMessage).toEqual({ text: "hi" });
    expect(calls.some((c) => c.path.includes("sendText"))).toBe(false);
  });

  test("a dedicated project routes to its instance", async () => {
    stubPhoton((call) =>
      call.path.includes("/imessage/tokens")
        ? Response.json({
            succeed: true,
            data: {
              type: "dedicated",
              auth: { "inst-7": "tok_dedicated" },
              numbers: { "inst-7": "+15550100" },
              expiresIn: 600,
            },
          })
        : Response.json({ message: { guid: "p2p-out", isFromMe: true } }),
    );

    await createPhotonProvider().send({ conversationId: "any;-;+1555" }, "hi", {
      idempotencyKey: "k3",
    });

    const headers = calls[1]?.init.headers as Record<string, string>;
    expect(headers["x-photon-server"]).toBe("inst-7");
    expect(headers.Authorization).toBe("Bearer tok_dedicated");
  });

  test("the token is minted once and reused", async () => {
    // A busy line must not mint per message.
    stubPhoton((call) =>
      call.path.includes("sendText")
        ? Response.json({ message: { guid: "p2p-out", isFromMe: true } })
        : undefined,
    );
    const provider = createPhotonProvider();

    await provider.send({ conversationId: "any;-;+1555" }, "one", {
      idempotencyKey: "a",
    });
    await provider.send({ conversationId: "any;-;+1555" }, "two", {
      idempotencyKey: "b",
    });

    const mints = calls.filter((c) => c.path.includes("/imessage/tokens"));
    expect(mints).toHaveLength(1);
  });

  test("a token that expired mid-flight is re-minted once", async () => {
    // Expiry is routine, not an error the caller should have to model.
    let sends = 0;
    stubPhoton((call) => {
      if (!call.path.includes("sendText")) return undefined;
      sends++;
      return sends === 1
        ? new Response("token expired", { status: 401 })
        : Response.json({ message: { guid: "p2p-retry", isFromMe: true } });
    });

    const result = await createPhotonProvider().send(
      { conversationId: "any;-;+1555" },
      "hi",
      { idempotencyKey: "k4" },
    );

    expect(result.id).toBe("p2p-retry");
    expect(calls.filter((c) => c.path.includes("/imessage/tokens"))).toHaveLength(
      2,
    );
  });

  test("polling normalizes inside the adapter and skips our own messages", async () => {
    stubPhoton((call) =>
      call.path.includes("listRecent")
        ? Response.json({
            messages: [
              photonMessage(),
              photonMessage({ guid: "p2p-B2", isFromMe: true }),
            ],
          })
        : undefined,
    );

    const records = await createPhotonProvider().fetchInbound({
      since: "2026-07-28T11:00:00.000Z",
      limit: 10,
    });

    expect(records).toHaveLength(2);
    expect(records[0]?.event?.actor.actorExternalId).toBe("+15551234567");
    expect(records[0]?.createdAt).toBe("2026-07-28T12:00:00.000Z");
    // An echo still carries its id, or the cursor never moves past it.
    expect(records[1]?.id).toBe("p2p-B2");
    expect(records[1]?.event).toBeUndefined();

    const listed = calls.find((c) => c.path.includes("listRecent"))?.path ?? "";
    expect(listed).toContain("after=2026-07-28T11%3A00%3A00.000Z");
    expect(listed).toContain("isFromMe=false");
  });

  test("normalizes the documented webhook delivery", () => {
    const event = createPhotonProvider().normalizeWebhook(
      photonWebhook(),
      "2026-07-28T12:00:30.000Z",
    );

    expect(event?.actor.actorExternalId).toBe("+15550100");
    // The space id is the chat guid a reply is addressed to, so binding on it
    // is what lets a reply skip chat resolution.
    expect(event?.message.conversationExternalId).toBe("any;-;+15550100");
    expect(event?.message.content).toBe("hey, what time is dinner?");
    expect(event?.source.chatType).toBe("imessage");
    expect(event?.receivedAt).toBe("2026-07-28T12:00:30.000Z");
  });

  test("an outbound echo is never a turn", () => {
    const event = createPhotonProvider().normalizeWebhook(
      photonWebhook({ direction: "outbound" }),
      "2026-07-28T12:00:30.000Z",
    );
    expect(event).toBeUndefined();
  });

  test("an unattributable delivery is dropped rather than guessed at", () => {
    const event = createPhotonProvider().normalizeWebhook(
      photonWebhook({ sender: { id: "not-a-number" } }),
      "2026-07-28T12:00:30.000Z",
    );
    expect(event).toBeUndefined();
  });

  test("supports polling", () => {
    expect(createPhotonProvider().supportsPolling).toBe(true);
  });
});

describe("webhook registration", () => {
  test("comms registers for message.received only, and keeps the secret", async () => {
    // Registering for message.sent would deliver our own replies back, and the
    // normalizer would drop every one of them. The `whsec_` secret comes back
    // from the 201 wrapped as `{ webhook }` — reading it out of the wrong
    // nesting stores nothing and fails every later verification.
    stubFetch((call) =>
      call.init.method === "GET"
        ? Response.json({ webhooks: [] })
        : Response.json({
            webhook: {
              id: "wh_1",
              url: "https://host.example/events-comms",
              secret: "whsec_abc",
            },
          }),
    );

    const result = await createCommsProvider().ensureWebhook({
      url: "https://host.example/events-comms",
      hasSecret: false,
    });

    expect(result).toEqual({
      created: true,
      id: "wh_1",
      secret: "whsec_abc",
    });
    expect(calls.map((c) => c.init.method)).toEqual(["GET", "POST"]);
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({
      url: "https://host.example/events-comms",
      events: ["comms.message.received"],
    });
  });

  test("comms re-reads a lost secret instead of re-registering", async () => {
    // The listing carries the secret, so a registration never has to be torn
    // down to recover one — unlike Photon, where it is issued exactly once.
    stubFetch((call) =>
      call.init.method === "GET"
        ? Response.json({
            webhooks: [
              {
                id: "wh_2",
                url: "https://host.example/mine",
                secret: "whsec_recovered",
              },
            ],
          })
        : Response.json({}),
    );

    const result = await createCommsProvider().ensureWebhook({
      url: "https://host.example/mine",
      hasSecret: false,
    });

    expect(result).toEqual({
      created: false,
      id: "wh_2",
      secret: "whsec_recovered",
    });
    expect(calls).toHaveLength(1);
  });

  test("comms does not re-register an existing url", async () => {
    // Called on every webhook-mode start, so creating blindly would pile up
    // registrations and deliver each message several times.
    stubFetch((call) =>
      call.init.method === "GET"
        ? Response.json({
            webhooks: [
              { id: "wh_1", url: "https://host.example/other" },
              { id: "wh_2", url: "https://host.example/mine" },
            ],
          })
        : Response.json({}),
    );

    const result = await createCommsProvider().ensureWebhook({
      url: "https://host.example/mine",
      hasSecret: true,
    });

    expect(result.created).toBe(false);
    expect(result.id).toBe("wh_2");
    expect(calls).toHaveLength(1);
  });

  test("comms reads a listing that came back bare", async () => {
    // The docs pin the POST body and say nothing about the listing envelope.
    stubFetch((call) =>
      call.init.method === "GET"
        ? Response.json([{ id: "wh_9", webhook_url: "https://host.example/mine" }])
        : Response.json({}),
    );

    expect(
      await createCommsProvider().ensureWebhook({
        url: "https://host.example/mine",
        hasSecret: true,
      }),
    ).toMatchObject({ created: false, id: "wh_9" });
  });

  test("photon registers through the control plane", async () => {
    stubPhoton((call) =>
      call.path.includes("/webhooks/")
        ? Response.json({
            succeed: true,
            data:
              call.init.method === "GET"
                ? []
                : { id: "wh_p", webhookUrl: "https://host.example/mine" },
          })
        : undefined,
    );

    const result = await createPhotonProvider().ensureWebhook({
      url: "https://host.example/mine",
      hasSecret: false,
    });

    expect(result).toEqual({ created: true, id: "wh_p", secret: undefined });
    expect(calls[0]?.path).toBe(
      `${PHOTON_CLOUD_BASE}/projects/test-key/webhooks/`,
    );
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({
      webhookUrl: "https://host.example/mine",
    });
  });

  test("photon does not re-register an existing url", async () => {
    stubPhoton((call) =>
      call.path.includes("/webhooks/")
        ? Response.json({
            succeed: true,
            data: [{ id: "wh_p", webhookUrl: "https://host.example/mine" }],
          })
        : undefined,
    );

    expect(
      await createPhotonProvider().ensureWebhook({
        url: "https://host.example/mine",
        hasSecret: true,
      }),
    ).toEqual({ created: false, id: "wh_p" });
    expect(calls).toHaveLength(1);
  });

  test("photon registration needs no message-plane token", async () => {
    // Webhooks are control-plane, so minting a message-plane token for one
    // would be a round trip that buys nothing.
    stubPhoton((call) =>
      call.path.includes("/webhooks/")
        ? Response.json({ succeed: true, data: [] })
        : undefined,
    );

    await createPhotonProvider().ensureWebhook({
      url: "https://host.example/mine",
      hasSecret: false,
    });
    expect(calls.some((c) => c.path.includes("/imessage/tokens"))).toBe(false);
  });
});

describe("photon webhook secrets", () => {
  test("re-registers when the signing secret was lost", async () => {
    // Photon issues the secret once, at creation, and its listing never
    // carries it. A registration whose secret we no longer hold is worse than
    // none: deliveries arrive and nothing can verify them.
    stubPhoton((call) => {
      if (!call.path.includes("/webhooks/")) return undefined;
      if (call.init.method === "GET") {
        return Response.json({
          succeed: true,
          data: [{ id: "wh_old", webhookUrl: "https://host.example/mine" }],
        });
      }
      if (call.init.method === "DELETE") {
        return Response.json({ succeed: true, data: {} });
      }
      return Response.json({
        succeed: true,
        data: {
          id: "wh_new",
          webhookUrl: "https://host.example/mine",
          signingSecret: "s3cr3t",
        },
      });
    });

    const result = await createPhotonProvider().ensureWebhook({
      url: "https://host.example/mine",
      hasSecret: false,
    });

    expect(result).toEqual({ created: true, id: "wh_new", secret: "s3cr3t" });
    expect(calls.map((c) => c.init.method)).toEqual(["GET", "DELETE", "POST"]);
    expect(calls[1]?.path).toContain("/webhooks/wh_old");
  });

  test("hands the issued secret back for the caller to store", async () => {
    stubPhoton((call) =>
      call.path.includes("/webhooks/")
        ? Response.json({
            succeed: true,
            data:
              call.init.method === "GET"
                ? []
                : { id: "wh_p", signingSecret: "issued-once" },
          })
        : undefined,
    );

    const result = await createPhotonProvider().ensureWebhook({
      url: "https://host.example/mine",
      hasSecret: false,
    });

    expect(result.secret).toBe("issued-once");
  });
});

describe("photon chat resolution", () => {
  test("resolves a handle's chat once and reuses it", async () => {
    // A long reply is several sends to the same recipient — both the skill
    // script and the transport chunk — and re-resolving per chunk would be a
    // round trip per bubble.
    stubPhoton((call) => {
      if (call.path.endsWith("/v1/chats")) {
        return Response.json({
          chat: { guid: "any;-;+15551234567" },
          initialMessage: { guid: "p2p-first", isFromMe: true },
        });
      }
      // Everything else but the token mint, which the fixture answers.
      return call.path.includes("sendText")
        ? Response.json({ message: { guid: "p2p-next", isFromMe: true } })
        : undefined;
    });
    const provider = createPhotonProvider();

    const first = await provider.send({ to: "+15551234567" }, "one", {
      idempotencyKey: "a",
    });
    const second = await provider.send({ to: "+15551234567" }, "two", {
      idempotencyKey: "b",
    });

    expect(first.id).toBe("p2p-first");
    expect(second.id).toBe("p2p-next");
    expect(calls.filter((c) => c.path.endsWith("/v1/chats"))).toHaveLength(1);
    expect(calls.filter((c) => c.path.includes("sendText"))).toHaveLength(1);
  });

  test("a chat guid target never resolves anything", async () => {
    stubPhoton((call) =>
      call.path.includes("sendText")
        ? Response.json({ message: { guid: "p2p-out", isFromMe: true } })
        : undefined,
    );

    await createPhotonProvider().send({ conversationId: "any;-;+1555" }, "hi", {
      idempotencyKey: "k",
    });

    expect(calls.some((c) => c.path.endsWith("/v1/chats"))).toBe(false);
  });
});
