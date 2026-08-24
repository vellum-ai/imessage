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
const { PHOTON_CLOUD_BASE } = await import("../providers/photon/client.ts");
type PhotonMessageClient = typeof import("../providers/photon/message-client.ts");
type MessageClientFactory = PhotonMessageClient["createMessageClient"];
type PhotonMessage = Awaited<
  ReturnType<ReturnType<MessageClientFactory>["sendText"]>
>;
type PhotonLiveEvent = import("../providers/photon/message-client.ts").PhotonLiveEvent;
type EventStream = import("../providers/photon/message-client.ts").EventStream<PhotonLiveEvent>;
type PhotonChatResult = Awaited<
  ReturnType<ReturnType<MessageClientFactory>["createChat"]>
>;
type MessageListPage = Awaited<
  ReturnType<ReturnType<MessageClientFactory>["listRecent"]>
>;
const { sameWebhookUrl } = await import("../webhook-endpoint.ts");
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

  test("knows every registered provider", () => {
    expect(PROVIDER_IDS).toContain("comms");
    expect(PROVIDER_IDS).toContain("photon");
    expect(PROVIDER_IDS).toContain("linq");
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
      expect(readiness.reason).toContain("Comms API key");
      expect(readiness.reason).toContain("could not be read");
    }
  });

  test("supports polling", () => {
    expect(createCommsProvider().supportsPolling).toBe(true);
  });

  test("does not support live ingress", () => {
    expect(createCommsProvider().supportsLive).toBe(false);
    expect(createCommsProvider().subscribeInbound).toBeUndefined();
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
    // A shared project, which is what user registration reads when a cold
    // send is refused with "Target not allowed".
    if (call.path.endsWith("/imessage/")) {
      return Response.json({ succeed: true, data: { type: "shared" } });
    }
    return Response.json({ succeed: true, data: {} });
  });
}

/** Control-plane calls a cold send makes, in order. */
function cloudPaths(): string[] {
  return calls.map((call) => new URL(call.path).pathname);
}

/**
 * A message as the SDK hands it back: decoded, with `dateCreated` a `Date`.
 *
 * Cast rather than fully populated — the SDK's `Message` carries about forty
 * fields and the adapter reads six of them. Spelling out the rest would be a
 * second copy of the vendor's type that could only ever drift from it.
 */
function photonMessage(
  overrides: Record<string, unknown> = {},
): PhotonMessage {
  return {
    guid: "p2p-A1",
    isFromMe: false,
    dateCreated: new Date("2026-07-28T12:00:00.000Z"),
    chatGuids: ["any;-;+15551234567"],
    sender: { address: "+15551234567", service: "iMessage" },
    content: { text: "hello" },
    ...overrides,
  } as unknown as PhotonMessage;
}

/** What the fake message plane was asked to do. */
interface PlaneCall {
  kind:
    | "sendText"
    | "createChat"
    | "listRecent"
    | "describeAddress"
    | "subscribeEvents"
    | "setTyping";
  input: Record<string, unknown>;
}

/**
 * A stand-in for the gRPC message plane.
 *
 * The real one opens a connection on construction, so every send test would
 * otherwise dial the network. `PhotonClient` takes the factory for exactly
 * this reason — see `message-client.ts`.
 */
function fakePlane(
  handler: (call: PlaneCall) => unknown = () => undefined,
  addressReport?: { address: string; country: string | null; services: string[] },
  liveEvents: PhotonLiveEvent[] = [],
): { factory: MessageClientFactory; calls: PlaneCall[]; closed: () => number } {
  const planeCalls: PlaneCall[] = [];
  let closes = 0;

  const record = (kind: PlaneCall["kind"], input: unknown): unknown => {
    const call = { kind, input: input as Record<string, unknown> };
    planeCalls.push(call);
    return handler(call);
  };

  const factory: MessageClientFactory = (opts) => ({
    async sendText(input) {
      // Resolving the token is what the real client does per RPC, and the
      // token-caching tests count the mints it triggers.
      await opts.token();
      return (record("sendText", input) as PhotonMessage) ?? photonMessage();
    },
    async createChat(input) {
      await opts.token();
      return (record("createChat", input) as PhotonChatResult) ?? { chat: {} as never };
    },
    async listRecent(input) {
      await opts.token();
      return (record("listRecent", input) as MessageListPage) ?? { messages: [] };
    },
    subscribeEvents(): EventStream {
      record("subscribeEvents", {});
      const events = liveEvents;
      return {
        async *[Symbol.asyncIterator]() {
          await opts.token();
          yield* events;
        },
        close() {},
      };
    },
    async describeAddress(address) {
      await opts.token();
      record("describeAddress", { address });
      return addressReport ?? { address, country: "US", services: ["iMessage"] };
    },
    async setTyping(chatGuid, isTyping) {
      await opts.token();
      record("setTyping", { chatGuid, isTyping });
    },
    async close() {
      closes++;
    },
  });

  return { factory, calls: planeCalls, closed: () => closes };
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

  test("a missing credential quotes what the store said", async () => {
    credentialMode = "throw";
    const readiness = await createPhotonProvider().checkReadiness();

    expect(readiness.ready).toBe(false);
    if (!readiness.ready) {
      expect(readiness.reason).toContain("Photon project ID");
      expect(readiness.reason).toContain("could not be read");
      expect(readiness.reason).toContain("credential not found");
    }
  });

  test("an unresolvable credential quotes what the store said", async () => {
    // The host raises one un-discriminated error for a missing reference, an
    // unreachable store, and a scoping refusal, so this cannot assert which it
    // was. Dropping the store's own words is what made a real incident
    // undiagnosable: registration failed and the reason named a setting that
    // was already correct.
    credentialMode = "throw";
    const readiness = await createPhotonProvider().checkReadiness();

    expect(readiness.ready).toBe(false);
    if (!readiness.ready) {
      expect(readiness.reason).toContain("credential not found");
    }
  });

  test("does not assert a credential is unset when it cannot know", async () => {
    // "is not set" sends the reader to check a setting. That is the right move
    // most of the time and exactly wrong when the store was merely down, and
    // from here the two are indistinguishable.
    credentialMode = "throw";
    const readiness = await createPhotonProvider().checkReadiness();

    expect(readiness.ready).toBe(false);
    if (!readiness.ready) {
      expect(readiness.reason).toContain("could not be read");
      expect(readiness.reason).not.toContain("is not set");
    }
  });

  test("an empty credential names the settings app", async () => {
    credentialValue = "";
    const readiness = await createPhotonProvider().checkReadiness();

    expect(readiness.ready).toBe(false);
    if (!readiness.ready) {
      expect(readiness.reason).toContain("is not set");
      expect(readiness.reason).toContain("settings app");
    }
  });

  test("a failed send surfaces what the plane said", async () => {
    // The plane is gRPC, so a failure arrives as a thrown SDK error rather
    // than a status code the client has to interpret. It must reach the
    // caller intact — the 415 loop happened because it did not.
    const plane = fakePlane(() => {
      throw new Error("[spectrum-imessage] Invalid token");
    });
    stubPhoton(() => undefined);

    await expect(
      createPhotonProvider(plane.factory).send({ to: "+15551234567" }, "hi", {
        idempotencyKey: "k1",
      }),
    ).rejects.toThrow("[spectrum-imessage] Invalid token");
  });

  test("a reply to a known chat mints a token and sends to the guid", async () => {
    const plane = fakePlane((call) =>
      call.kind === "sendText" ? photonMessage({ guid: "p2p-out" }) : undefined,
    );
    stubPhoton(() => undefined);

    const result = await createPhotonProvider(plane.factory).send(
      { conversationId: "any;-;+15551234567" },
      "hi",
      { idempotencyKey: "k1" },
    );

    expect(result.id).toBe("p2p-out");
    // The token still comes off the control plane; only the send moved.
    expect(calls[0]?.path).toBe(
      `${PHOTON_CLOUD_BASE}/projects/test-key/imessage/tokens`,
    );
    expect(plane.calls).toEqual([
      {
        kind: "sendText",
        input: {
          chatGuid: "any;-;+15551234567",
          text: "hi",
          clientMessageId: "k1",
        },
      },
    ]);
  });

  test("a cold send resolves a chat without registering a user first", async () => {
    // Direct SDK createChat already delivers without POST /users/. Registering
    // first blocked sends when that control-plane call failed, even though
    // the message plane would have accepted the recipient.
    const plane = fakePlane((call) =>
      call.kind === "createChat"
        ? {
            chat: { guid: "any;-;+15551234567" },
            initialMessage: photonMessage({ guid: "p2p-first" }),
          }
        : undefined,
    );
    stubPhoton(() => undefined);

    await createPhotonProvider(plane.factory).send(
      { to: "+15166681354" },
      "hi",
      { idempotencyKey: "k" },
    );

    expect(cloudPaths().some((p) => p.endsWith("/users/"))).toBe(false);
    expect(cloudPaths()).toEqual(["/projects/test-key/imessage/tokens"]);
    expect(plane.calls.map((c) => c.kind)).toEqual(["createChat"]);
  });

  test("a target-not-allowed refusal registers the recipient and retries", async () => {
    let creates = 0;
    const plane = fakePlane((call) => {
      if (call.kind === "createChat") {
        creates += 1;
        if (creates === 1) {
          throw new Error("Target not allowed for this project");
        }
        return {
          chat: { guid: "any;-;+15166681354" },
          initialMessage: photonMessage({ guid: "p2p-first" }),
        };
      }
      return undefined;
    });
    stubPhoton(() => undefined);

    const result = await createPhotonProvider(plane.factory).send(
      { to: "+15166681354" },
      "hi",
      { idempotencyKey: "k" },
    );

    expect(result.id).toBe("p2p-first");
    expect(cloudPaths().filter((p) => p.endsWith("/users/"))).toHaveLength(1);
    const registration = calls.find((c) => c.path.endsWith("/users/"));
    expect(JSON.parse(String(registration?.init.body))).toEqual({
      type: "shared",
      phoneNumber: "+15166681354",
    });
    expect(plane.calls.filter((c) => c.kind === "createChat")).toHaveLength(2);
  });

  test("a refusal carries Photon's own verdict on the address", async () => {
    // "Target not allowed for this project" is equally consistent with a
    // missing user record, an unreachable handle, and a Photon-side bug. The
    // user record was just written, so the report has to say which.
    const plane = fakePlane(
      (call) => {
        if (call.kind === "createChat") {
          throw new Error("Target not allowed for this project");
        }
        return undefined;
      },
      { address: "+15166681354", country: "US", services: ["SMS"] },
    );
    stubPhoton(() => undefined);

    const send = createPhotonProvider(plane.factory).send(
      { to: "+15166681354" },
      "hi",
      { idempotencyKey: "k" },
    );

    await expect(send).rejects.toThrow(/Target not allowed for this project/);
    await expect(send).rejects.toThrow(/services: SMS/);
    expect(plane.calls.map((c) => c.kind)).toContain("describeAddress");
  });

  test("a probe that fails does not swallow the refusal", async () => {
    const plane = fakePlane((call) => {
      if (call.kind === "createChat") {
        throw new Error("Target not allowed for this project");
      }
      if (call.kind === "describeAddress") throw new Error("plane unavailable");
      return undefined;
    });
    stubPhoton(() => undefined);

    await expect(
      createPhotonProvider(plane.factory).send({ to: "+15166681354" }, "hi", {
        idempotencyKey: "k",
      }),
    ).rejects.toThrow(/Target not allowed[\s\S]*plane unavailable/);
  });

  test("an ordinary send failure is not probed", async () => {
    // The diagnostic is for one specific refusal. Firing it on every failure
    // would add a round trip to paths that already say what went wrong.
    const plane = fakePlane((call) => {
      if (call.kind === "createChat") throw new Error("UNAVAILABLE: no route");
      return undefined;
    });
    stubPhoton(() => undefined);

    await expect(
      createPhotonProvider(plane.factory).send({ to: "+15166681354" }, "hi", {
        idempotencyKey: "k",
      }),
    ).rejects.toThrow("UNAVAILABLE: no route");
    expect(plane.calls.map((c) => c.kind)).not.toContain("describeAddress");
  });

  test("a reply to a known chat registers nobody", async () => {
    // The recipient is already messageable, so a reply must not pay a
    // registration round trip — nor consume a shared-user slot.
    const plane = fakePlane(() => photonMessage({ guid: "p2p-out" }));
    stubPhoton(() => undefined);

    await createPhotonProvider(plane.factory).send(
      { conversationId: "any;-;+15551234567" },
      "hi",
      { idempotencyKey: "k" },
    );

    expect(cloudPaths().some((p) => p.endsWith("/users/"))).toBe(false);
  });

  test("typing uses a chat guid without creating a chat", async () => {
    const plane = fakePlane();
    stubPhoton(() => undefined);
    const provider = createPhotonProvider(plane.factory);

    await provider.setTyping?.(
      { conversationId: "any;-;+15551234567" },
      true,
    );
    await provider.setTyping?.(
      { conversationId: "any;-;+15551234567" },
      false,
    );

    expect(plane.calls.filter((c) => c.kind === "setTyping")).toEqual([
      {
        kind: "setTyping",
        input: { chatGuid: "any;-;+15551234567", isTyping: true },
      },
      {
        kind: "setTyping",
        input: { chatGuid: "any;-;+15551234567", isTyping: false },
      },
    ]);
  });

  test("typing with a guid in `to` still reaches the plane", async () => {
    // Live turns address the chat as `{ to: conversationExternalId }`, and
    // Photon live events carry a chat guid there.
    const plane = fakePlane();
    stubPhoton(() => undefined);

    await createPhotonProvider(plane.factory).setTyping?.(
      { to: "any;-;+15551234567" },
      true,
    );

    expect(plane.calls.filter((c) => c.kind === "setTyping")).toEqual([
      {
        kind: "setTyping",
        input: { chatGuid: "any;-;+15551234567", isTyping: true },
      },
    ]);
  });

  test("typing on an unknown handle creates nothing", async () => {
    // Dots in a chat Photon has never seen would force a createChat, which
    // is a send's job. Stay quiet until a guid exists.
    const plane = fakePlane();
    stubPhoton(() => undefined);

    await createPhotonProvider(plane.factory).setTyping?.(
      { to: "+15551234567" },
      true,
    );

    expect(plane.calls).toEqual([]);
  });

  test("a dedicated project assigns the recipient to its own line", async () => {
    // A dedicated user has to name a line the project owns. The token mint
    // already reports those, so this costs no extra call. Registration still
    // runs only after the plane refuses the handle.
    let creates = 0;
    stubPhoton((call) => {
      if (call.path.endsWith("/imessage/")) {
        return Response.json({ succeed: true, data: { type: "dedicated" } });
      }
      if (call.path.includes("/imessage/tokens")) {
        return Response.json({
          succeed: true,
          data: {
            type: "dedicated",
            auth: { "inst-7": "tok_dedicated" },
            numbers: { "inst-7": "+15550100" },
            expiresIn: 600,
          },
        });
      }
      return undefined;
    });
    const plane = fakePlane((call) => {
      if (call.kind === "createChat") {
        creates += 1;
        if (creates === 1) {
          throw new Error("Target not allowed for this project");
        }
        return {
          chat: { guid: "any;-;+15166681354" },
          initialMessage: photonMessage({ guid: "p2p-first" }),
        };
      }
      return undefined;
    });

    await createPhotonProvider(plane.factory).send(
      { to: "+15166681354" },
      "hi",
      { idempotencyKey: "k" },
    );

    const registration = calls.find((c) => c.path.endsWith("/users/"));
    expect(JSON.parse(String(registration?.init.body))).toEqual({
      type: "dedicated",
      phoneNumber: "+15166681354",
      assignedPhoneNumber: "+15550100",
    });
  });

  test("allowRecipient registers the handle and sends nothing", async () => {
    // Setup has to make a number messageable without delivering a test
    // bubble to it. A send that happens to register on the way out is how
    // this used to work, and it is why a setup check arrived as "Target
    // not allowed" for a number Photon had never been told about.
    stubPhoton(() => undefined);

    const result = await createPhotonProvider(fakePlane().factory).allowRecipient?.(
      "+15166681354",
    );

    expect(result).toEqual({ phoneNumber: "+15166681354" });
    expect(cloudPaths()).toEqual([
      "/projects/test-key/imessage/",
      "/projects/test-key/users/",
    ]);
    const registration = calls.find((c) => c.path.endsWith("/users/"));
    expect(JSON.parse(String(registration?.init.body))).toEqual({
      type: "shared",
      phoneNumber: "+15166681354",
    });
  });

  test("allowRecipient pulls the phone out of a chat guid", async () => {
    stubPhoton(() => undefined);
    const result = await createPhotonProvider(fakePlane().factory).allowRecipient?.(
      "any;-;+15166681354",
    );
    expect(result?.phoneNumber).toBe("+15166681354");
    const registration = calls.find((c) => c.path.endsWith("/users/"));
    expect(JSON.parse(String(registration?.init.body)).phoneNumber).toBe(
      "+15166681354",
    );
  });

  test("allowRecipient refuses junk before calling Photon", async () => {
    stubPhoton(() => undefined);
    await expect(
      createPhotonProvider(fakePlane().factory).allowRecipient?.("12345"),
    ).rejects.toThrow(/not a phone number/);
    expect(calls).toHaveLength(0);
  });

  test("comms does not restrict recipients", () => {
    expect(createCommsProvider().allowRecipient).toBeUndefined();
  });

  test("a dedicated project with no line says so rather than failing later", async () => {
    stubPhoton((call) => {
      if (call.path.endsWith("/imessage/")) {
        return Response.json({ succeed: true, data: { type: "dedicated" } });
      }
      if (call.path.includes("/imessage/tokens")) {
        return Response.json({
          succeed: true,
          data: {
            type: "dedicated",
            auth: { "inst-7": "tok_dedicated" },
            expiresIn: 600,
          },
        });
      }
      return undefined;
    });
    const plane = fakePlane((call) => {
      if (call.kind === "createChat") {
        throw new Error("Target not allowed for this project");
      }
      return undefined;
    });

    await expect(
      createPhotonProvider(plane.factory).send(
        { to: "+15166681354" },
        "hi",
        { idempotencyKey: "k" },
      ),
    ).rejects.toThrow(/no line to assign/);
  });

  test("a cold send to a bare handle resolves the chat in the same call", async () => {
    // Photon addresses conversations by chat guid, so a raw handle needs one
    // resolved. Carrying the text along makes that one round trip, not two.
    const plane = fakePlane((call) =>
      call.kind === "createChat"
        ? {
            chat: { guid: "any;-;+15551234567" },
            initialMessage: photonMessage({ guid: "p2p-first" }),
          }
        : undefined,
    );
    stubPhoton(() => undefined);

    const result = await createPhotonProvider(plane.factory).send(
      { to: "+15551234567" },
      "hi",
      { idempotencyKey: "k2" },
    );

    expect(result.id).toBe("p2p-first");
    expect(plane.calls).toHaveLength(1);
    expect(plane.calls[0]).toEqual({
      kind: "createChat",
      input: {
        addresses: ["+15551234567"],
        clientMessageId: "k2",
        text: "hi",
      },
    });
  });

  test("a chat that resolves without a message is sent to explicitly", async () => {
    // Reporting a delivery that may not have happened is the one outcome
    // worth a second round trip.
    const plane = fakePlane((call) =>
      call.kind === "createChat"
        ? { chat: { guid: "any;-;+15551234567" } }
        : photonMessage({ guid: "p2p-follow" }),
    );
    stubPhoton(() => undefined);

    const result = await createPhotonProvider(plane.factory).send(
      { to: "+15551234567" },
      "hi",
      { idempotencyKey: "k5" },
    );

    expect(result.id).toBe("p2p-follow");
    expect(plane.calls.map((c) => c.kind)).toEqual(["createChat", "sendText"]);
  });

  test("the token is minted once and reused", async () => {
    // A busy line must not mint per message. The SDK asks for a token on
    // every RPC, so the client's cache is what keeps that off the wire.
    const plane = fakePlane();
    stubPhoton(() => undefined);
    const provider = createPhotonProvider(plane.factory);

    await provider.send({ conversationId: "any;-;+1555" }, "one", {
      idempotencyKey: "a",
    });
    await provider.send({ conversationId: "any;-;+1555" }, "two", {
      idempotencyKey: "b",
    });

    const mints = calls.filter((c) => c.path.includes("/imessage/tokens"));
    expect(mints).toHaveLength(1);
    expect(plane.calls).toHaveLength(2);
  });

  test("a dedicated project sends its instance token", async () => {
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
        : undefined,
    );

    let handed: string | undefined;
    const factory: MessageClientFactory = (opts) => ({
      async sendText() {
        handed = await opts.token();
        return photonMessage({ guid: "p2p-out" });
      },
      createChat: () => Promise.resolve({ chat: {} } as never),
      listRecent: () => Promise.resolve({ messages: [] }),
      subscribeEvents: () => ({
        async *[Symbol.asyncIterator]() {},
        close() {},
      }),
      describeAddress: (address: string) =>
        Promise.resolve({ address, country: null, services: [] }),
      close: () => Promise.resolve(),
    });

    await createPhotonProvider(factory).send(
      { conversationId: "any;-;+1555" },
      "hi",
      { idempotencyKey: "k3" },
    );

    expect(handed).toBe("tok_dedicated");
  });

  test("polling normalizes inside the adapter and skips our own messages", async () => {
    const plane = fakePlane((call) =>
      call.kind === "listRecent"
        ? {
            messages: [
              photonMessage(),
              photonMessage({ guid: "p2p-B2", isFromMe: true }),
            ],
          }
        : undefined,
    );
    stubPhoton(() => undefined);

    const records = await createPhotonProvider(plane.factory).fetchInbound({
      since: "2026-07-28T11:00:00.000Z",
      limit: 10,
    });

    expect(records).toHaveLength(2);
    expect(records[0]?.event?.actor.actorExternalId).toBe("+15551234567");
    expect(records[0]?.createdAt).toBe("2026-07-28T12:00:00.000Z");
    // An echo still carries its id, or the cursor never moves past it.
    expect(records[1]?.id).toBe("p2p-B2");
    expect(records[1]?.event).toBeUndefined();

    expect(plane.calls[0]?.input).toEqual({
      after: new Date("2026-07-28T11:00:00.000Z"),
      limit: 10,
      isFromMe: false,
    });
  });

  test("closing the provider releases the gRPC channel", async () => {
    // A provider is rebuilt on every settings save, and the plane is a live
    // connection with its own keepalive. Without this each save leaks one.
    const plane = fakePlane();
    stubPhoton(() => undefined);
    const provider = createPhotonProvider(plane.factory);

    await provider.send({ conversationId: "any;-;+1555" }, "hi", {
      idempotencyKey: "k",
    });
    await provider.close?.();

    expect(plane.closed()).toBe(1);
  });

  /** The event of a delivery the classifier called a message, or undefined. */
  function messageFrom(raw: unknown, receivedAt: string) {
    const delivery = createPhotonProvider().classifyWebhook(raw, receivedAt);
    return delivery.kind === "message" ? delivery.event : undefined;
  }

  test("normalizes the documented webhook delivery", () => {
    const event = messageFrom(photonWebhook(), "2026-07-28T12:00:30.000Z");

    expect(event?.actor.actorExternalId).toBe("+15550100");
    // The space id is the chat guid a reply is addressed to, so binding on it
    // is what lets a reply skip chat resolution.
    expect(event?.message.conversationExternalId).toBe("any;-;+15550100");
    expect(event?.message.content).toBe("hey, what time is dinner?");
    expect(event?.source.chatType).toBe("imessage");
    expect(event?.receivedAt).toBe("2026-07-28T12:00:30.000Z");
  });

  test("an outbound echo is never a turn", () => {
    const event = messageFrom(
      photonWebhook({ direction: "outbound" }),
      "2026-07-28T12:00:30.000Z",
    );
    expect(event).toBeUndefined();
  });

  test("an unattributable delivery is dropped rather than guessed at", () => {
    const event = messageFrom(
      photonWebhook({ sender: { id: "not-a-number" } }),
      "2026-07-28T12:00:30.000Z",
    );
    expect(event).toBeUndefined();
  });

  test("supports polling", () => {
    expect(createPhotonProvider().supportsPolling).toBe(true);
  });

  test("supports live ingress over the message-plane stream", () => {
    expect(createPhotonProvider().supportsLive).toBe(true);
  });

  test("live subscribe normalizes message.received and skips the rest", async () => {
    stubPhoton(() => undefined);
    const plane = fakePlane(() => undefined, undefined, [
      {
        type: "message.read",
        sequence: 1,
      },
      {
        type: "message.received",
        sequence: 2,
        message: photonMessage({ guid: "p2p-in" }),
      },
      {
        type: "message.received",
        sequence: 3,
        message: photonMessage({ guid: "p2p-me", isFromMe: true }),
      },
    ]);

    const records = [];
    const sub = createPhotonProvider(plane.factory).subscribeInbound?.();
    if (!sub) {
      throw new Error("expected subscribeInbound");
    }
    for await (const record of sub) {
      records.push(record);
    }

    expect(records).toHaveLength(2);
    expect(records[0]?.id).toBe("p2p-in");
    expect(records[0]?.event?.actor.actorExternalId).toBe("+15551234567");
    expect(records[1]?.id).toBe("p2p-me");
    expect(records[1]?.event).toBeUndefined();
  });
});

describe("webhook registration", () => {
  test("comms registers for message.received and ping, and keeps the secret", async () => {
    // Registering for message.sent would deliver our own replies back, and the
    // normalizer would drop every one of them. Ping is the dashboard Send
    // test; without it that delivery sits pending with zero attempts. The
    // `whsec_` secret comes back from the 201 wrapped as `{ webhook }` —
    // reading it out of the wrong nesting stores nothing and fails every
    // later verification.
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
      events: ["comms.message.received", "comms.ping"],
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

  test("comms replaces a received-only registration so ping is subscribed", async () => {
    // A webhook that only names `comms.message.received` never sees the
    // dashboard Send test: Comms leaves `comms.ping` pending with zero
    // attempts rather than posting an event the endpoint is not subscribed
    // to. Recreating is what adds ping without a dashboard round trip.
    stubFetch((call) => {
      if (call.init.method === "GET") {
        return Response.json({
          webhooks: [
            {
              id: "wh_old",
              url: "https://host.example/events-comms",
              secret: "whsec_old",
              events: ["comms.message.received"],
            },
          ],
        });
      }
      if (call.init.method === "DELETE") {
        expect(call.path).toBe("/webhooks/wh_old");
        return new Response(null, { status: 204 });
      }
      return Response.json({
        webhook: {
          id: "wh_new",
          url: "https://host.example/events-comms",
          secret: "whsec_new",
          events: ["comms.message.received", "comms.ping"],
        },
      });
    });

    const result = await createCommsProvider().ensureWebhook({
      url: "https://host.example/events-comms",
      hasSecret: true,
    });

    expect(result).toEqual({
      created: true,
      id: "wh_new",
      secret: "whsec_new",
    });
    expect(calls.map((c) => c.init.method)).toEqual(["GET", "DELETE", "POST"]);
    expect(JSON.parse(String(calls[2]?.init.body))).toEqual({
      url: "https://host.example/events-comms",
      events: ["comms.message.received", "comms.ping"],
    });
  });

  test("comms keeps a registration that already includes ping", async () => {
    stubFetch((call) =>
      call.init.method === "GET"
        ? Response.json({
            webhooks: [
              {
                id: "wh_ok",
                url: "https://host.example/events-comms",
                secret: "whsec_ok",
                events: ["comms.message.received", "comms.ping"],
              },
            ],
          })
        : Response.json({}),
    );

    const result = await createCommsProvider().ensureWebhook({
      url: "https://host.example/events-comms",
      hasSecret: true,
    });

    expect(result).toEqual({
      created: false,
      id: "wh_ok",
      secret: "whsec_ok",
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

  test("comms reuses a registration stored with a trailing slash", async () => {
    // The platform's callback registration used to append one, so a webhook
    // created then is stored as `.../events-comms/`. Reading that as a
    // different address creates a second registration beside it: both deliver,
    // each signed with its own secret, and the plugin holds only the newer one
    // — so every other delivery 403s on verification, seemingly depending on
    // which spelling of the URL was used.
    stubFetch((call) =>
      call.init.method === "GET"
        ? Response.json({
            webhooks: [
              {
                id: "wh_slashed",
                url: "https://host.example/events-comms/",
                secret: "whsec_existing",
              },
            ],
          })
        : Response.json({}),
    );

    const result = await createCommsProvider().ensureWebhook({
      url: "https://host.example/events-comms",
      hasSecret: false,
    });

    expect(result).toEqual({
      created: false,
      id: "wh_slashed",
      secret: "whsec_existing",
    });
    expect(calls).toHaveLength(1);
  });

  test("comms still treats a different path as a different registration", () => {
    // Only the trailing slash is forgiven. Anything else really is another
    // address, and matching on it would leave a stale registration pointed
    // somewhere the gateway does not serve.
    expect(
      sameWebhookUrl(
        "https://host.example/events-comms",
        "https://host.example/events-photon",
      ),
    ).toBe(false);
    expect(
      sameWebhookUrl(
        "https://host.example/events-comms",
        "https://other.example/events-comms",
      ),
    ).toBe(false);
    expect(
      sameWebhookUrl(
        "https://host.example/events-comms",
        "https://host.example/events-comms/",
      ),
    ).toBe(true);
    expect(
      sameWebhookUrl(
        "https://host.example/events-linq/?version=2026-02-03",
        "https://host.example/events-linq?version=2026-02-03",
      ),
    ).toBe(true);
    expect(
      sameWebhookUrl(
        "https://host.example/events-linq/?version=2026-02-03",
        "https://host.example/events-linq/?version=2025-01-01",
      ),
    ).toBe(false);
  });

  test("comms prefers the exact url when a duplicate already exists", async () => {
    // A deployment that grew a second registration before the comparison was
    // fixed has two live webhooks and two secrets, and only the one whose
    // secret is stored verifies. Which one that is decides which half of the
    // traffic 403s, so it is picked deterministically rather than by whatever
    // order the provider listed them in.
    stubFetch((call) =>
      call.init.method === "GET"
        ? Response.json({
            webhooks: [
              {
                id: "wh_slashed",
                url: "https://host.example/events-comms/",
                secret: "whsec_stale",
              },
              {
                id: "wh_exact",
                url: "https://host.example/events-comms",
                secret: "whsec_current",
              },
            ],
          })
        : Response.json({}),
    );

    expect(
      await createCommsProvider().ensureWebhook({
        url: "https://host.example/events-comms",
        hasSecret: false,
      }),
    ).toEqual({
      created: false,
      id: "wh_exact",
      secret: "whsec_current",
    });
  });

  test("photon replaces a slashless registration so the vendor posts at a trailing slash", async () => {
    // Photon stores and calls the URL it was given. A slashless one 301s at
    // Vellum's managed gateway, and that redirect 404s the POST. Recreating
    // even when we hold a secret is what moves the vendor onto the
    // canonical spelling; matching still finds the old row so it is deleted
    // rather than left delivering beside the new one.
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
        data: { id: "wh_new", signingSecret: "s3cr3t" },
      });
    });

    expect(
      await createPhotonProvider().ensureWebhook({
        url: "https://host.example/mine/",
        hasSecret: true,
      }),
    ).toEqual({ created: true, id: "wh_new", secret: "s3cr3t" });
    expect(calls.map((c) => c.init.method)).toEqual(["GET", "DELETE", "POST"]);
    expect(JSON.parse(String(calls[2]?.init.body))).toEqual({
      webhookUrl: "https://host.example/mine/",
    });
  });

  test("photon replaces a slashed registration when the secret is gone", async () => {
    // The registration is found, so it is deleted rather than left behind to
    // deliver alongside the new one.
    stubPhoton((call) => {
      if (!call.path.includes("/webhooks/")) return undefined;
      if (call.init.method === "GET") {
        return Response.json({
          succeed: true,
          data: [{ id: "wh_old", webhookUrl: "https://host.example/mine/" }],
        });
      }
      if (call.init.method === "DELETE") {
        return Response.json({ succeed: true, data: {} });
      }
      return Response.json({
        succeed: true,
        data: { id: "wh_new", signingSecret: "s3cr3t" },
      });
    });

    await createPhotonProvider().ensureWebhook({
      url: "https://host.example/mine",
      hasSecret: false,
    });

    expect(calls.map((c) => c.init.method)).toEqual(["GET", "DELETE", "POST"]);
    expect(calls[1]?.path).toContain("/webhooks/wh_old");
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
    const plane = fakePlane((call) =>
      call.kind === "createChat"
        ? {
            chat: { guid: "any;-;+15551234567" },
            initialMessage: photonMessage({ guid: "p2p-first" }),
          }
        : photonMessage({ guid: "p2p-next" }),
    );
    stubPhoton(() => undefined);
    const provider = createPhotonProvider(plane.factory);

    const first = await provider.send({ to: "+15551234567" }, "one", {
      idempotencyKey: "a",
    });
    const second = await provider.send({ to: "+15551234567" }, "two", {
      idempotencyKey: "b",
    });

    expect(first.id).toBe("p2p-first");
    expect(second.id).toBe("p2p-next");
    expect(plane.calls.map((c) => c.kind)).toEqual(["createChat", "sendText"]);
  });

  test("a chat guid target never resolves anything", async () => {
    const plane = fakePlane(() => photonMessage({ guid: "p2p-out" }));
    stubPhoton(() => undefined);

    await createPhotonProvider(plane.factory).send(
      { conversationId: "any;-;+1555" },
      "hi",
      { idempotencyKey: "k" },
    );

    expect(plane.calls.map((c) => c.kind)).toEqual(["sendText"]);
  });

  test("the resolved guid is dropped when the provider closes", async () => {
    // The cache is keyed by handle and lives as long as the provider. A new
    // provider must re-resolve rather than trust a guid from a line that may
    // now be a different project entirely.
    const plane = fakePlane((call) =>
      call.kind === "createChat"
        ? {
            chat: { guid: "any;-;+15551234567" },
            initialMessage: photonMessage({ guid: "p2p-first" }),
          }
        : photonMessage({ guid: "p2p-next" }),
    );
    stubPhoton(() => undefined);
    const provider = createPhotonProvider(plane.factory);

    await provider.send({ to: "+15551234567" }, "one", { idempotencyKey: "a" });
    await provider.close?.();
    await provider.send({ to: "+15551234567" }, "two", { idempotencyKey: "b" });

    expect(plane.calls.map((c) => c.kind)).toEqual([
      "createChat",
      "createChat",
    ]);
  });
});
