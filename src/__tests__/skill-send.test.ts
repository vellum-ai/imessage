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
type ResolveProviderOptions =
  import("../providers/index.ts").ResolveProviderOptions;

interface Call {
  url: string;
  init: RequestInit;
}

/** What the fake message plane was asked to do. */
interface PlaneCall {
  kind: "sendText" | "createChat";
  input: { clientMessageId: string };
}

const originalFetch = globalThis.fetch;
let calls: Call[] = [];
let planeCalls: PlaneCall[] = [];

/**
 * The control plane, which is all Photon still serves over HTTP.
 *
 * Sends and chat resolution moved to gRPC, so they are exercised through the
 * injected plane below rather than by stubbing `fetch`.
 */
function stubControlPlane(): void {
  globalThis.fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    const href = String(url);
    calls.push({ url: href, init: init ?? {} });

    if (href.endsWith("/imessage/")) {
      return Response.json({ succeed: true, data: { type: "shared" } });
    }
    if (href.endsWith("/users/")) {
      return Response.json({
        succeed: true,
        data: { id: "usr_1", phoneNumber: "+15551234567" },
      });
    }
    return Response.json({
      succeed: true,
      data: { type: "shared", token: "tok_live", expiresIn: 600 },
    });
  }) as unknown as typeof fetch;
}

/** A message plane that resolves a chat, then accepts sends into it. */
function stubPlane(
  onSend: (index: number) => unknown = () => undefined,
): Pick<ResolveProviderOptions, "photonMessageClient"> {
  let sends = 0;
  return {
    photonMessageClient: (opts) => ({
      async createChat(input) {
        await opts.token();
        planeCalls.push({ kind: "createChat", input });
        return {
          chat: { guid: "any;-;+15551234567" },
          initialMessage: { guid: "p2p-first" },
        } as never;
      },
      async sendText(input) {
        await opts.token();
        planeCalls.push({ kind: "sendText", input });
        const answer = onSend(++sends);
        if (answer instanceof Error) throw answer;
        return { guid: `p2p-${sends + 1}` } as never;
      },
      listRecent: () => Promise.resolve({ messages: [] }),
      close: () => Promise.resolve(),
    }),
  };
}

function pathsCalled(): string[] {
  return calls.map((call) => new URL(call.url).pathname);
}

beforeEach(() => {
  calls = [];
  planeCalls = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("skill send", () => {
  test("goes out over the configured provider's adapter", async () => {
    // The script picks no provider of its own: `resolveProvider` answers, the
    // same way it does for the channel transport.
    stubControlPlane();
    const sent = await sendMessage(
      { to: "+15551234567", body: "hello" },
      stubPlane(),
    );

    expect(sent).toEqual([{ id: "p2p-first", body: "hello" }]);
    // What is left on HTTP: read the project type, register the recipient as
    // a user, mint a token. Photon refuses to message anyone the project does
    // not know, so the registration is part of a cold send, not setup.
    expect(pathsCalled()).toEqual([
      "/projects/proj_1/imessage/",
      "/projects/proj_1/users/",
      "/projects/proj_1/imessage/tokens",
    ]);
    expect(planeCalls.map((c) => c.kind)).toEqual(["createChat"]);
  });

  test("resolves the chat once, then sends every chunk into it", async () => {
    // Re-resolving per chunk would be a round trip per bubble on every long
    // reply.
    stubControlPlane();
    const sent = await sendMessage(
      { to: "+15551234567", body: "word ".repeat(700) },
      stubPlane(),
    );

    expect(sent.length).toBeGreaterThan(1);
    expect(planeCalls.filter((c) => c.kind === "createChat")).toHaveLength(1);
    expect(planeCalls.filter((c) => c.kind === "sendText")).toHaveLength(
      sent.length - 1,
    );
    // The recipient is registered once, and the token minted once, however
    // many bubbles the reply becomes.
    expect(pathsCalled().filter((p) => p.endsWith("/users/"))).toHaveLength(1);
    expect(
      pathsCalled().filter((p) => p.endsWith("/imessage/tokens")),
    ).toHaveLength(1);
  });

  test("every chunk carries its own idempotency key", async () => {
    // A long reply can legitimately repeat itself, so keying on the body alone
    // would have the provider collapse a duplicate chunk and drop it.
    stubControlPlane();
    await sendMessage(
      { to: "+15551234567", body: "word ".repeat(700) },
      stubPlane(),
    );

    const keys = planeCalls.map((c) => c.input.clientMessageId);
    expect(keys.every(Boolean)).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("a provider failure surfaces the provider's own reason", async () => {
    // A control-plane failure, which is where a bad credential shows up: the
    // token mint answers `succeed: false` and the send never starts.
    globalThis.fetch = (async () =>
      Response.json({
        succeed: false,
        message: "invalid credentials",
      })) as unknown as typeof fetch;

    await expect(
      sendMessage({ to: "+15551234567", body: "hi" }, stubPlane()),
    ).rejects.toThrow(/invalid credentials/);
  });

  test("partial delivery is reported, never hidden", async () => {
    // The recipient already has the earlier chunks; the assistant has to know
    // how many landed.
    stubControlPlane();

    await expect(
      sendMessage(
        { to: "+15551234567", body: "word ".repeat(700) },
        stubPlane((index) =>
          index === 1 ? undefined : new Error("[spectrum-imessage] rejected"),
        ),
      ),
    ).rejects.toThrow(/Sent \d+ of \d+ messages, then failed/);
  });

  test("an unaddressable recipient is refused before anything is sent", async () => {
    stubControlPlane();

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
