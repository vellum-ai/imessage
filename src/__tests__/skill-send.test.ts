/**
 * The `imessage` skill's standalone send path.
 *
 * This is the assistant's deliberate-send route, and it now has to speak
 * whichever provider is configured — which since Photon became the default
 * means the default install exercises the Photon path.
 *
 * `node:child_process` is mocked so no credential is revealed and no `assistant`
 * binary is required; `fetch` is stubbed so nothing leaves the process. There is
 * no `config.json` in the repo, so `configuredProvider()` falls through to its
 * default, which is exactly the case under test.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const realChildProcess = await import("node:child_process");

/** Credential values by field, as `assistant credentials reveal` would print. */
const credentials: Record<string, string> = {
  photon_project_id: "proj_1",
  photon_project_secret: "shh",
  api_key: "sk-comms",
};

mock.module("node:child_process", () => ({
  ...realChildProcess,
  execFileSync: (_file: string, args: string[]) => {
    const field = args[args.indexOf("--field") + 1] ?? "";
    return `${credentials[field] ?? ""}\n`;
  },
}));

const { sendMessage, DEFAULT_PROVIDER } = await import(
  "../../skills/imessage/scripts/imessage-client.ts"
);
const { IMessageConfigSchema } = await import("../config.ts");

interface Call {
  url: string;
  init: RequestInit;
}

const originalFetch = globalThis.fetch;
let calls: Call[] = [];

function stubPhotonWire(): void {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    calls.push({ url: href, init: init ?? {} });

    if (href.includes("/imessage/tokens")) {
      return Response.json({
        succeed: true,
        data: { type: "shared", token: "tok_live", expiresIn: 600 },
      });
    }
    if (href.endsWith("/v1/chats")) {
      return Response.json({ chat: { guid: "any;-;+15551234567" } });
    }
    return Response.json({ message: { guid: `p2p-${calls.length}` } });
  }) as typeof fetch;
}

function headersOf(call: Call | undefined): Record<string, string> {
  return (call?.init.headers ?? {}) as Record<string, string>;
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("skill send", () => {
  test("its default provider matches the config schema's", () => {
    // The script reads `config.json` directly rather than through the schema,
    // so the fallback is stated twice. Two defaults that disagree means the
    // script sends over a different line than the channel does.
    expect(DEFAULT_PROVIDER).toBe(IMessageConfigSchema.parse({}).provider);
  });

  test("sends over Photon: mint, open the chat, then send", async () => {
    stubPhotonWire();
    const sent = await sendMessage({ to: "+15551234567", body: "hello" });

    expect(sent.map((chunk) => chunk.body)).toEqual(["hello"]);
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/projects/proj_1/imessage/tokens",
      "/v1/chats",
      "/v1/messages:sendText",
    ]);

    // The control plane takes the project pair; the message plane takes the
    // token minted from it.
    expect(headersOf(calls[0]).Authorization).toBe(
      `Basic ${btoa("proj_1:shh")}`,
    );
    expect(headersOf(calls[2]).Authorization).toBe("Bearer tok_live");
  });

  test("opens the chat once, then sends every chunk into it", async () => {
    // Re-minting between chunks would leave the recipient with half a reply if
    // a credential prompt or a token failure landed mid-send.
    stubPhotonWire();
    const long = "word ".repeat(700);
    const sent = await sendMessage({ to: "+15551234567", body: long });

    expect(sent.length).toBeGreaterThan(1);
    expect(calls.filter((c) => c.url.includes("/imessage/tokens"))).toHaveLength(
      1,
    );
    expect(calls.filter((c) => c.url.endsWith("/v1/chats"))).toHaveLength(1);
  });

  test("every chunk carries its own idempotency key", async () => {
    // A long reply can legitimately repeat itself, so keying on the body alone
    // would have the provider collapse a duplicate chunk and drop it.
    stubPhotonWire();
    await sendMessage({ to: "+15551234567", body: "word ".repeat(700) });

    const sends = calls.filter((c) => c.url.includes("sendText"));
    const keys = sends.map((c) => headersOf(c)["x-idempotency-key"]);

    expect(keys.every(Boolean)).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("a refused token names the credentials rather than the endpoint", async () => {
    globalThis.fetch = (async () =>
      Response.json({
        succeed: false,
        message: "invalid credentials",
      })) as unknown as typeof fetch;

    await expect(
      sendMessage({ to: "+15551234567", body: "hi" }),
    ).rejects.toThrow(/invalid credentials/);
  });

  test("nothing is sent when the chat cannot be resolved", async () => {
    // Reporting a delivery that did not happen is the worst outcome here.
    globalThis.fetch = (async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes("/imessage/tokens")) {
        return Response.json({
          succeed: true,
          data: { type: "shared", token: "tok_live" },
        });
      }
      return Response.json({});
    }) as unknown as typeof fetch;

    await expect(
      sendMessage({ to: "+15551234567", body: "hi" }),
    ).rejects.toThrow(/no chat guid/);
  });
});
