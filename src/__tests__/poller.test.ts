import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { PluginInboundEvent } from "../channel/contract.ts";
import type { CommsClient, ListMessagesInput } from "../comms/client.ts";
import type { ListMessagesResponse } from "../comms/schemas.ts";
import { readCursor } from "../cursor.ts";
import { CommsPoller } from "../poller.ts";

const SILENT_LOGGER = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "imessage-poller-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function message(overrides: Record<string, unknown> = {}) {
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

/** Client stub returning a scripted page per call. */
function stubClient(pages: unknown[][]): {
  client: CommsClient;
  calls: ListMessagesInput[];
} {
  const calls: ListMessagesInput[] = [];
  let index = 0;
  const client = {
    async listMessages(input: ListMessagesInput = {}) {
      calls.push(input);
      const page = pages[index++] ?? [];
      return { messages: page } as unknown as ListMessagesResponse;
    },
  } as unknown as CommsClient;
  return { client, calls };
}

function makePoller(
  client: CommsClient,
  sink: (event: PluginInboundEvent) => void,
  extra: { isAllowed?: (handle: string) => boolean } = {},
) {
  return new CommsPoller({
    client,
    storageDir: dir,
    intervalMs: 5_000,
    logger: SILENT_LOGGER,
    sink,
    now: () => new Date("2026-07-28T12:00:30.000Z"),
    ...extra,
  });
}

describe("CommsPoller", () => {
  test("delivers normalized inbound messages to the sink", async () => {
    const { client } = stubClient([[message()]]);
    const events: PluginInboundEvent[] = [];
    const poller = makePoller(client, (e) => events.push(e));

    expect(await poller.pollOnce()).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.actor.actorExternalId).toBe("+15551234567");
  });

  test("does not redeliver a message across polls", async () => {
    // The reason the cursor carries ids and not just a timestamp: a `since`
    // bound that may be inclusive would otherwise replay the boundary message
    // on every single poll.
    const { client } = stubClient([[message()], [message()]]);
    const events: PluginInboundEvent[] = [];
    const poller = makePoller(client, (e) => events.push(e));

    expect(await poller.pollOnce()).toBe(1);
    expect(await poller.pollOnce()).toBe(0);
    expect(events).toHaveLength(1);
  });

  test("delivers a second message sharing the boundary timestamp", async () => {
    // The other half of the boundary problem: an exclusive bound with no id
    // set would lose this one.
    const { client } = stubClient([
      [message({ id: "msg_01" })],
      [message({ id: "msg_01" }), message({ id: "msg_02" })],
    ]);
    const events: PluginInboundEvent[] = [];
    const poller = makePoller(client, (e) => events.push(e));

    await poller.pollOnce();
    expect(await poller.pollOnce()).toBe(1);
    expect(events.map((e) => e.message.externalMessageId)).toEqual([
      "msg_01",
      "msg_02",
    ]);
  });

  test("advances past messages that normalize to nothing", async () => {
    // Otherwise an unattributable message sits behind the cursor and is
    // re-fetched on every poll forever.
    const { client } = stubClient([
      [message({ id: "msg_bad", from: undefined })],
      [],
    ]);
    const poller = makePoller(client, () => {});

    expect(await poller.pollOnce()).toBe(0);
    expect(readCursor(dir).seenIds).toContain("msg_bad");
  });

  test("passes the stored cursor as the since bound", async () => {
    const { client, calls } = stubClient([[message()], []]);
    const poller = makePoller(client, () => {});

    await poller.pollOnce();
    await poller.pollOnce();

    expect(calls[1]?.since).toBe("2026-07-28T12:00:00.000Z");
    expect(calls[1]?.direction).toBe("inbound");
  });

  test("applies the handle allowlist", async () => {
    const { client } = stubClient([
      [message({ id: "a", from: "+15551234567" }), message({ id: "b", from: "+15559990000" })],
    ]);
    const events: PluginInboundEvent[] = [];
    const poller = makePoller(client, (e) => events.push(e), {
      isAllowed: (handle) => handle === "+15551234567",
    });

    expect(await poller.pollOnce()).toBe(1);
    expect(events[0]?.actor.actorExternalId).toBe("+15551234567");
  });

  test("start() with no stored cursor polls from now, not from history", async () => {
    // A newly installed plugin replaying months of old messages as fresh turns
    // would be worse than missing them.
    const { client } = stubClient([[]]);
    const poller = makePoller(client, () => {});
    poller.start();
    poller.stop();

    expect(readCursor(dir).since).toBe("2026-07-28T12:00:30.000Z");
  });

  test("start() keeps an existing cursor", async () => {
    const { client } = stubClient([[]]);
    const first = makePoller(client, () => {});
    first.start();
    first.stop();

    const stored = readCursor(dir).since;
    const second = makePoller(client, () => {});
    second.start();
    second.stop();

    expect(readCursor(dir).since).toBe(stored);
  });

  test("a failing poll propagates rather than silently advancing", async () => {
    const client = {
      async listMessages() {
        throw new Error("429");
      },
    } as unknown as CommsClient;
    const poller = makePoller(client, () => {});

    await expect(poller.pollOnce()).rejects.toThrow("429");
    expect(readCursor(dir)).toEqual({ since: undefined, seenIds: [] });
  });

  test("stop() is safe when never started", () => {
    const { client } = stubClient([[]]);
    expect(() => makePoller(client, () => {}).stop()).not.toThrow();
  });
});
