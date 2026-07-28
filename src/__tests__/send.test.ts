/**
 * Outbound send tests.
 *
 * `sendMessage` is what the `send_imessage` tool and the `/send` route both
 * call, so this is the path an outbound bring-up test exercises. The cases
 * that matter are the ones a first real send hits: a channel that is idle, a
 * handle typed the way humans type them, and a provider that rejects.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const realPluginApi = await import("@vellumai/plugin-api");

mock.module("@vellumai/plugin-api", () => ({
  ...realPluginApi,
  resolveCredential: mock(async () => "test-key"),
}));

const { startChannelRuntime, stopIngress } = await import(
  "../channel-runtime.ts"
);
const { IMessageConfigSchema } = await import("../config.ts");
const { resetPluginState, setInitContext } = await import(
  "../plugin-state.ts"
);
const { sendMessage } = await import("../send.ts");
const { COMMS_API_BASE } = await import("../providers/comms/client.ts");

const SILENT_LOGGER = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const originalFetch = globalThis.fetch;
let bodies: unknown[] = [];

function stubSend(response: () => Response): void {
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    if (String(url).startsWith(COMMS_API_BASE)) {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
    }
    return response();
  }) as typeof fetch;
}

function bringUpComms(): void {
  setInitContext({
    logger: SILENT_LOGGER,
    pluginStorageDir: "/tmp/imessage-send-test",
    pluginName: "imessage",
  });
  startChannelRuntime(
    IMessageConfigSchema.parse({ provider: "comms", ingressMode: "webhook" }),
  );
}

beforeEach(() => {
  bodies = [];
  resetPluginState();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  stopIngress();
  resetPluginState();
});

describe("sendMessage", () => {
  test("sends through the transport and reports the message id", async () => {
    stubSend(() =>
      Response.json({ message: { id: "msg_out", direction: "outbound" } }),
    );
    bringUpComms();

    const result = await sendMessage("+15551234567", "hello");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.to).toBe("+15551234567");
      expect(result.externalMessageId).toBe("msg_out");
    }
    expect(bodies[0]).toMatchObject({ to: "+15551234567", body: "hello" });
  });

  test("normalizes a human-typed handle before sending", async () => {
    // A raw "(555) 123-4567" would reach the provider as a malformed address.
    stubSend(() => Response.json({ message: { id: "m", direction: "outbound" } }));
    bringUpComms();

    const result = await sendMessage("(555) 123-4567", "hi");

    expect(result.ok).toBe(true);
    expect(bodies[0]).toMatchObject({ to: "+15551234567" });
  });

  test("goes through the transport, so markdown is flattened", async () => {
    // The reason send.ts calls the transport rather than the provider: a test
    // path that skipped it would prove the credentials work and nothing else.
    stubSend(() => Response.json({ message: { id: "m", direction: "outbound" } }));
    bringUpComms();

    await sendMessage("+15551234567", "**bold** and `code`");

    expect(bodies[0]).toMatchObject({ body: "bold and code" });
  });

  test("rejects an unusable handle before calling the provider", async () => {
    stubSend(() => Response.json({}));
    bringUpComms();

    const result = await sendMessage("not a number", "hi");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("E.164");
    expect(bodies).toHaveLength(0);
  });

  test("rejects an empty body before calling the provider", async () => {
    stubSend(() => Response.json({}));
    bringUpComms();

    const result = await sendMessage("+15551234567", "   ");

    expect(result.ok).toBe(false);
    expect(bodies).toHaveLength(0);
  });

  test("surfaces a provider failure instead of reporting success", async () => {
    stubSend(() => new Response("nope", { status: 401 }));
    bringUpComms();

    const result = await sendMessage("+15551234567", "hi");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("401");
  });

  test("an idle vellum channel explains how to send today", async () => {
    // The exact state a first outbound test hits on default config. The error
    // has to name the next action, not just say "not initialized".
    setInitContext({
      logger: SILENT_LOGGER,
      pluginStorageDir: "/tmp/imessage-send-test",
      pluginName: "imessage",
    });
    startChannelRuntime(IMessageConfigSchema.parse({ provider: "vellum" }));

    const result = await sendMessage("+15551234567", "hi");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("provider");
      expect(result.error).toContain("comms");
    }
  });

  test("an uninitialized plugin fails cleanly", async () => {
    const result = await sendMessage("+15551234567", "hi");
    expect(result.ok).toBe(false);
  });
});
