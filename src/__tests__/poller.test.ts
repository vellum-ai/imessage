import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { PluginInboundEvent } from "../channel/contract.ts";
import { readCursor } from "../cursor.ts";
import { Poller } from "../poller.ts";
import type {
  FetchInboundOptions,
  InboundRecord,
  MessagingProvider,
} from "../providers/types.ts";

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

function event(
  id: string,
  actorExternalId = "+15551234567",
): PluginInboundEvent {
  return {
    version: "v1",
    sourceChannel: "imessage",
    receivedAt: "2026-07-28T12:00:30.000Z",
    message: {
      content: "hello",
      conversationExternalId: "conv_abc",
      externalMessageId: id,
    },
    actor: { actorExternalId },
    source: { updateId: id, messageId: id, chatType: "imessage" },
    raw: {},
  };
}

function record(
  id: string,
  createdAt: string | undefined,
  ev?: PluginInboundEvent,
): InboundRecord {
  return { id, createdAt, event: ev };
}

/** Provider stub returning a scripted page per call. */
function stubProvider(
  pages: InboundRecord[][],
  overrides: Partial<MessagingProvider> = {},
): { provider: MessagingProvider; calls: FetchInboundOptions[] } {
  const calls: FetchInboundOptions[] = [];
  let index = 0;
  const provider: MessagingProvider = {
    id: "comms",
    label: "stub",
    supportsPolling: true,
    async checkReadiness() {
      return { ready: true };
    },
    async ensureWebhook() {
      return { created: false };
    },
    async fetchInbound(opts: FetchInboundOptions) {
      calls.push(opts);
      return pages[index++] ?? [];
    },
    async send() {
      return {};
    },
    classifyWebhook() {
      return { kind: "ignored" as const, reason: "stub" };
    },
    ...overrides,
  };
  return { provider, calls };
}

function makePoller(
  provider: MessagingProvider,
  sink: (e: PluginInboundEvent) => void,
) {
  return new Poller({
    provider,
    storageDir: dir,
    intervalMs: 5_000,
    logger: SILENT_LOGGER,
    sink,
    now: () => new Date("2026-07-28T12:00:30.000Z"),
  });
}

describe("Poller", () => {
  test("delivers normalized events to the sink", async () => {
    const { provider } = stubProvider([
      [record("msg_01", "2026-07-28T12:00:00.000Z", event("msg_01"))],
    ]);
    const events: PluginInboundEvent[] = [];
    const poller = makePoller(provider, (e) => events.push(e));

    expect(await poller.pollOnce()).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.actor.actorExternalId).toBe("+15551234567");
  });

  test("never sees a provider-shaped payload", async () => {
    // The seam that keeps this file provider-agnostic: adapters normalize
    // before handing a record back, so the poller only handles InboundRecord.
    const { provider, calls } = stubProvider([[]]);
    const poller = makePoller(provider, () => {});
    await poller.pollOnce();
    expect(Object.keys(calls[0] ?? {}).sort()).toEqual(["limit", "since"]);
  });

  test("does not redeliver a record across polls", async () => {
    const rec = record("msg_01", "2026-07-28T12:00:00.000Z", event("msg_01"));
    const { provider } = stubProvider([[rec], [rec]]);
    const events: PluginInboundEvent[] = [];
    const poller = makePoller(provider, (e) => events.push(e));

    expect(await poller.pollOnce()).toBe(1);
    expect(await poller.pollOnce()).toBe(0);
    expect(events).toHaveLength(1);
  });

  test("delivers a second record sharing the boundary timestamp", async () => {
    const ts = "2026-07-28T12:00:00.000Z";
    const { provider } = stubProvider([
      [record("msg_01", ts, event("msg_01"))],
      [record("msg_01", ts, event("msg_01")), record("msg_02", ts, event("msg_02"))],
    ]);
    const events: PluginInboundEvent[] = [];
    const poller = makePoller(provider, (e) => events.push(e));

    await poller.pollOnce();
    expect(await poller.pollOnce()).toBe(1);
    expect(events.map((e) => e.message.externalMessageId)).toEqual([
      "msg_01",
      "msg_02",
    ]);
  });

  test("advances past records that carry no event", async () => {
    // Otherwise a non-turn record sits behind the cursor and is re-fetched on
    // every poll forever.
    const { provider } = stubProvider([
      [record("msg_bad", "2026-07-28T12:00:00.000Z", undefined)],
      [],
    ]);
    const poller = makePoller(provider, () => {});

    expect(await poller.pollOnce()).toBe(0);
    expect(readCursor(dir).seenIds).toContain("msg_bad");
  });

  test("passes the stored cursor as the since bound", async () => {
    const { provider, calls } = stubProvider([
      [record("msg_01", "2026-07-28T12:00:00.000Z", event("msg_01"))],
      [],
    ]);
    const poller = makePoller(provider, () => {});

    await poller.pollOnce();
    await poller.pollOnce();

    expect(calls[1]?.since).toBe("2026-07-28T12:00:00.000Z");
  });

  test("delivers every sender, filtering none", async () => {
    // Same rule as the webhook route: the plugin does not decide who may
    // reach the assistant, so a second sender from the same batch is not the
    // poller's business to drop.
    const ts = "2026-07-28T12:00:00.000Z";
    const { provider } = stubProvider([
      [
        record("a", ts, event("a", "+15551234567")),
        record("b", ts, event("b", "+15559990000")),
      ],
    ]);
    const events: PluginInboundEvent[] = [];
    const poller = makePoller(provider, (e) => events.push(e));

    expect(await poller.pollOnce()).toBe(2);
    expect(events.map((e) => e.actor.actorExternalId)).toEqual([
      "+15551234567",
      "+15559990000",
    ]);
  });

  test("start() with no stored cursor polls from now, not from history", async () => {
    const { provider } = stubProvider([[]]);
    const poller = makePoller(provider, () => {});
    poller.start();
    poller.stop();

    expect(readCursor(dir).since).toBe("2026-07-28T12:00:30.000Z");
  });

  test("start() refuses a webhook-only provider", () => {
    // Fail loudly at start rather than on the first tick, so a bad config is
    // visible immediately.
    const { provider } = stubProvider([[]], { supportsPolling: false });
    expect(() => makePoller(provider, () => {}).start()).toThrow(
      /does not support polling/,
    );
  });

  test("a failing poll propagates rather than silently advancing", async () => {
    const { provider } = stubProvider([], {
      async fetchInbound() {
        throw new Error("429");
      },
    });
    const poller = makePoller(provider, () => {});

    await expect(poller.pollOnce()).rejects.toThrow("429");
    expect(readCursor(dir)).toEqual({ since: undefined, seenIds: [] });
  });

  test("stop() is safe when never started", () => {
    const { provider } = stubProvider([[]]);
    expect(() => makePoller(provider, () => {}).stop()).not.toThrow();
  });
});
