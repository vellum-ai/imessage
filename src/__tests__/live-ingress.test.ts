/**
 * Live ingress loop.
 *
 * What matters here is reconnect, dedupe, and stop: the adapter already
 * normalizes, so this file drives a scripted subscribe and checks the loop
 * around it.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { PluginInboundEvent } from "../channel/contract.ts";
import { LiveIngress } from "../live-ingress.ts";
import type {
  InboundRecord,
  LiveInboundSubscription,
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
  dir = mkdtempSync(join(tmpdir(), "imessage-live-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function event(id: string): PluginInboundEvent {
  return {
    version: "v1",
    sourceChannel: "imessage",
    receivedAt: "2026-07-28T12:00:30.000Z",
    message: {
      content: "hello",
      conversationExternalId: "conv_abc",
      externalMessageId: id,
    },
    actor: { actorExternalId: "+15551234567" },
    source: { updateId: id, messageId: id, chatType: "imessage" },
    raw: {},
  };
}

function record(
  id: string,
  ev?: PluginInboundEvent,
): InboundRecord {
  return { id, createdAt: "2026-07-28T12:00:00.000Z", event: ev };
}

function subscription(
  records: InboundRecord[],
  mode: "end" | "hang" = "end",
): LiveInboundSubscription {
  const abort = new AbortController();
  return {
    async *[Symbol.asyncIterator]() {
      yield* records;
      if (mode === "hang") {
        await new Promise<void>((resolve) => {
          if (abort.signal.aborted) {
            resolve();
            return;
          }
          abort.signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
    },
    close() {
      abort.abort();
    },
  };
}

function stubProvider(
  sessions: InboundRecord[][],
  overrides: Partial<MessagingProvider> = {},
): { provider: MessagingProvider; subscribed: () => number } {
  let calls = 0;
  const provider: MessagingProvider = {
    id: "photon",
    label: "stub",
    supportsPolling: true,
    supportsLive: true,
    async checkReadiness() {
      return { ready: true };
    },
    async fetchInbound() {
      return [];
    },
    async ensureWebhook() {
      return { created: false };
    },
    subscribeInbound() {
      const index = calls++;
      return subscription(sessions[index] ?? [], "end");
    },
    async send() {
      return {};
    },
    classifyWebhook() {
      return { kind: "ignored" as const, reason: "stub" };
    },
    ...overrides,
  };
  return { provider, subscribed: () => calls };
}

function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error("timed out waiting for live ingress"));
        return;
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

describe("LiveIngress", () => {
  test("delivers normalized events to the sink", async () => {
    const events: PluginInboundEvent[] = [];
    const { provider } = stubProvider(
      [[record("m1", event("m1"))]],
      {
        subscribeInbound() {
          return subscription([record("m1", event("m1"))], "hang");
        },
      },
    );
    const live = new LiveIngress({
      provider,
      storageDir: dir,
      logger: SILENT_LOGGER,
      sink: (e) => {
        events.push(e);
      },
      sleep: () => new Promise(() => {}),
    });

    live.start();
    await waitFor(() => events.length === 1);
    live.stop();

    expect(events[0]?.message.externalMessageId).toBe("m1");
  });

  test("does not redeliver the same id", async () => {
    const events: PluginInboundEvent[] = [];
    const provider = stubProvider([]).provider;
    provider.subscribeInbound = () =>
      subscription(
        [record("m1", event("m1")), record("m1", event("m1"))],
        "hang",
      );

    const live = new LiveIngress({
      provider,
      storageDir: dir,
      logger: SILENT_LOGGER,
      sink: (e) => {
        events.push(e);
      },
      sleep: () => new Promise(() => {}),
    });

    live.start();
    await waitFor(() => events.length === 1);
    live.stop();

    expect(events).toHaveLength(1);
  });

  test("skips a record that is not a turn", async () => {
    const events: PluginInboundEvent[] = [];
    const provider = stubProvider([]).provider;
    provider.subscribeInbound = () =>
      subscription([record("echo")], "hang");

    const live = new LiveIngress({
      provider,
      storageDir: dir,
      logger: SILENT_LOGGER,
      sink: (e) => {
        events.push(e);
      },
      sleep: () => new Promise(() => {}),
    });

    live.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    live.stop();

    expect(events).toEqual([]);
  });

  test("reconnects after the stream ends", async () => {
    const events: PluginInboundEvent[] = [];
    const { provider, subscribed } = stubProvider([
      [record("m1", event("m1"))],
      [record("m2", event("m2"))],
    ]);

    const live = new LiveIngress({
      provider,
      storageDir: dir,
      logger: SILENT_LOGGER,
      sink: (e) => {
        events.push(e);
      },
      sleep: async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
    });

    live.start();
    await waitFor(() => events.length === 2);
    live.stop();

    expect(events.map((e) => e.message.externalMessageId)).toEqual(["m1", "m2"]);
    expect(subscribed()).toBeGreaterThanOrEqual(2);
  });

  test("stop() prevents a reconnect", async () => {
    let calls = 0;
    const provider = stubProvider([]).provider;
    provider.subscribeInbound = () => {
      calls++;
      return subscription([record("m1", event("m1"))], "end");
    };

    const live = new LiveIngress({
      provider,
      storageDir: dir,
      logger: SILENT_LOGGER,
      sink: () => {},
      sleep: () => new Promise(() => {}),
    });

    live.start();
    await waitFor(() => calls === 1);
    live.stop();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(calls).toBe(1);
  });

  test("refuses a provider without live support", () => {
    const { provider } = stubProvider([], {
      supportsLive: false,
      subscribeInbound: undefined,
    });
    const live = new LiveIngress({
      provider,
      logger: SILENT_LOGGER,
      sink: () => {},
    });

    expect(() => live.start()).toThrow(/does not support live ingress/);
  });

  test("waits when the provider is not ready, without subscribing", async () => {
    let subscribed = 0;
    const { provider } = stubProvider([]);
    provider.checkReadiness = async () => ({
      ready: false,
      reason: "no credentials",
    });
    provider.subscribeInbound = () => {
      subscribed++;
      return subscription([], "hang");
    };

    const live = new LiveIngress({
      provider,
      logger: SILENT_LOGGER,
      sink: () => {},
      sleep: () => new Promise(() => {}),
    });

    live.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    live.stop();

    expect(subscribed).toBe(0);
  });
});
