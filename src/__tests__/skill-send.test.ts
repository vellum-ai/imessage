/**
 * The `imessage` skill's standalone send path.
 *
 * It runs the plugin's own provider adapters from a separate process, which is
 * the thing worth pinning: `resolveCredential` is mocked here the same way the
 * provider tests mock it, and a send comes out the other side as real provider
 * wire calls rather than as a second copy of them.
 *
 * There is no `config.json` in the repo, so `readConfigView` answers with the
 * schema's defaults — meaning these exercise the default provider, which is the
 * path a fresh install takes.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const realPluginApi = await import("@vellumai/plugin-api");

/** Credential values by field, as the store would answer. */
const credentials: Record<string, string> = {
  photon_project_id: "proj_1",
  photon_project_secret: "shh",
  api_key: "sk-comms",
};

mock.module("@vellumai/plugin-api", () => ({
  ...realPluginApi,
  resolveCredential: mock(async (ref: string) => {
    const field = ref.split("/")[1] ?? "";
    const value = credentials[field];
    if (!value) throw new Error(`no credential for ${ref}`);
    return value;
  }),
}));

const { sendMessage, normalizeRecipient } = await import(
  "../../skills/imessage/scripts/imessage-client.ts"
);

interface Call {
  url: string;
  init: RequestInit;
}

const originalFetch = globalThis.fetch;
let calls: Call[] = [];

/** The Photon wire: mint a token, resolve a chat, then send into it. */
function stubPhotonWire(): void {
  globalThis.fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    const href = String(url);
    calls.push({ url: href, init: init ?? {} });

    if (href.includes("/imessage/tokens")) {
      return Response.json({
        succeed: true,
        data: { type: "shared", token: "tok_live", expiresIn: 600 },
      });
    }
    if (href.endsWith("/v1/chats")) {
      return Response.json({
        chat: { guid: "any;-;+15551234567" },
        initialMessage: { guid: "p2p-first", isFromMe: true },
      });
    }
    return Response.json({
      message: { guid: `p2p-${calls.length}`, isFromMe: true },
    });
  }) as unknown as typeof fetch;
}

function pathsCalled(): string[] {
  return calls.map((call) => new URL(call.url).pathname);
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("skill send", () => {
  test("goes out over the configured provider's adapter", async () => {
    // The script picks no provider of its own: `resolveProvider` answers, the
    // same way it does for the channel transport.
    stubPhotonWire();
    const sent = await sendMessage({ to: "+15551234567", body: "hello" });

    expect(sent).toEqual([{ id: "p2p-first", body: "hello" }]);
    expect(pathsCalled()).toEqual([
      "/projects/proj_1/imessage/tokens",
      "/v1/chats",
    ]);
  });

  test("resolves the chat once, then sends every chunk into it", async () => {
    // Re-resolving per chunk would be a round trip per bubble on every long
    // reply.
    stubPhotonWire();
    const sent = await sendMessage({
      to: "+15551234567",
      body: "word ".repeat(700),
    });

    expect(sent.length).toBeGreaterThan(1);
    expect(calls.filter((c) => c.url.endsWith("/v1/chats"))).toHaveLength(1);
    expect(
      calls.filter((c) => c.url.includes("/imessage/tokens")),
    ).toHaveLength(1);
    expect(calls.filter((c) => c.url.includes("sendText")).length).toBe(
      sent.length - 1,
    );
  });

  test("every chunk carries its own idempotency key", async () => {
    // A long reply can legitimately repeat itself, so keying on the body alone
    // would have the provider collapse a duplicate chunk and drop it.
    stubPhotonWire();
    await sendMessage({ to: "+15551234567", body: "word ".repeat(700) });

    const keys = calls
      .filter((c) => c.url.includes("sendText"))
      .map(
        (c) => (c.init.headers as Record<string, string>)["x-idempotency-key"],
      );

    expect(keys.every(Boolean)).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("a provider failure surfaces the provider's own reason", async () => {
    globalThis.fetch = (async () =>
      Response.json({
        succeed: false,
        message: "invalid credentials",
      })) as unknown as typeof fetch;

    await expect(
      sendMessage({ to: "+15551234567", body: "hi" }),
    ).rejects.toThrow(/invalid credentials/);
  });

  test("partial delivery is reported, never hidden", async () => {
    // The recipient already has the earlier chunks; the assistant has to know
    // how many landed.
    let sends = 0;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes("/imessage/tokens")) {
        return Response.json({
          succeed: true,
          data: { type: "shared", token: "tok_live" },
        });
      }
      if (href.endsWith("/v1/chats")) {
        return Response.json({
          chat: { guid: "any;-;+1555" },
          initialMessage: { guid: "p2p-first", isFromMe: true },
        });
      }
      sends++;
      // 400, not 500: a 5xx is retryable, so the client would back off three
      // times before the failure this test is about.
      return sends === 1
        ? Response.json({ message: { guid: "p2p-2", isFromMe: true } })
        : new Response("nope", { status: 400 });
    }) as unknown as typeof fetch;

    await expect(
      sendMessage({ to: "+15551234567", body: "word ".repeat(700) }),
    ).rejects.toThrow(/Sent \d+ of \d+ messages, then failed/);
  });

  test("an unaddressable recipient is refused before anything is sent", async () => {
    stubPhotonWire();

    await expect(sendMessage({ to: "12345", body: "hi" })).rejects.toThrow(
      /not a recipient/,
    );
    expect(calls).toHaveLength(0);
  });

  test("normalizes a recipient the way the channel does", () => {
    // One normalizer for skill sends and inbound turns, or the same person
    // becomes two contacts.
    expect(normalizeRecipient("(555) 123-4567")).toBe("+15551234567");
    expect(normalizeRecipient("+1 555 123 4567")).toBe("+15551234567");
  });
});
