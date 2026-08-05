import { describe, expect, test } from "bun:test";

import type { PluginInboundEvent } from "../channel/contract.ts";
import { parseBootstrapArg } from "../worker/poll-worker.ts";
import {
  encodeWorkerMessage,
  parseWorkerLine,
  WorkerBootstrapSchema,
} from "../worker/protocol.ts";
import type { WorkerHandle } from "../worker/supervisor.ts";
import { PollWorkerSupervisor } from "../worker/supervisor.ts";

const SILENT_LOGGER = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const BOOTSTRAP = {
  storageDir: "/tmp/imessage-test",
  intervalMs: 5_000,
  provider: "comms" as const,
};

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
    source: { updateId: id },
    raw: {},
  };
}

/** Handle backed by a scripted stdout stream. */
function stubHandle(lines: string[]): WorkerHandle & { killed: boolean } {
  const encoder = new TextEncoder();
  const handle = {
    killed: false,
    stdout: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const line of lines) controller.enqueue(encoder.encode(line));
        controller.close();
      },
    }),
    exited: new Promise<number>(() => {}),
    kill() {
      handle.killed = true;
    },
  };
  return handle;
}

describe("worker protocol", () => {
  test("round-trips a message", () => {
    const encoded = encodeWorkerMessage({ type: "ready" });
    expect(encoded.endsWith("\n")).toBe(true);
    expect(parseWorkerLine(encoded)).toEqual({ type: "ready" });
  });

  test("drops a malformed line instead of throwing", () => {
    // A stray write from a dependency on the worker's stdout must not take the
    // channel down.
    expect(parseWorkerLine("not json")).toBeUndefined();
    expect(parseWorkerLine("")).toBeUndefined();
    expect(parseWorkerLine("   ")).toBeUndefined();
    expect(parseWorkerLine("null")).toBeUndefined();
    expect(parseWorkerLine('{"no":"type"}')).toBeUndefined();
  });

  test("bootstrap requires the fields the worker cannot infer", () => {
    expect(WorkerBootstrapSchema.safeParse(BOOTSTRAP).success).toBe(true);
    expect(WorkerBootstrapSchema.safeParse({}).success).toBe(false);
    expect(
      WorkerBootstrapSchema.safeParse({ ...BOOTSTRAP, intervalMs: -1 }).success,
    ).toBe(false);
  });

  test("parseBootstrapArg rejects a missing argument", () => {
    expect(() => parseBootstrapArg(undefined)).toThrow(/without a bootstrap/);
    expect(parseBootstrapArg(JSON.stringify(BOOTSTRAP)).provider).toBe("comms");
  });
});

describe("PollWorkerSupervisor", () => {
  test("forwards events from the worker to the sink", async () => {
    const events: PluginInboundEvent[] = [];
    const handle = stubHandle([
      encodeWorkerMessage({ type: "ready" }),
      encodeWorkerMessage({ type: "event", event: event("msg_01") }),
    ]);

    const supervisor = new PollWorkerSupervisor({
      bootstrap: BOOTSTRAP,
      logger: SILENT_LOGGER,
      sink: (e) => void events.push(e),
      spawn: () => handle,
    });
    supervisor.start();
    await Bun.sleep(20);
    supervisor.stop();

    expect(events.map((e) => e.message.externalMessageId)).toEqual(["msg_01"]);
  });

  test("reassembles a message split across chunk boundaries", async () => {
    // A pipe splits wherever it likes; parsing a partial line as a whole
    // message would drop it.
    const events: PluginInboundEvent[] = [];
    const full = encodeWorkerMessage({ type: "event", event: event("msg_02") });
    const handle = stubHandle([full.slice(0, 30), full.slice(30)]);

    const supervisor = new PollWorkerSupervisor({
      bootstrap: BOOTSTRAP,
      logger: SILENT_LOGGER,
      sink: (e) => void events.push(e),
      spawn: () => handle,
    });
    supervisor.start();
    await Bun.sleep(20);
    supervisor.stop();

    expect(events.map((e) => e.message.externalMessageId)).toEqual(["msg_02"]);
  });

  test("survives an interleaved malformed line", async () => {
    const events: PluginInboundEvent[] = [];
    const handle = stubHandle([
      "garbage not json\n",
      encodeWorkerMessage({ type: "event", event: event("msg_03") }),
    ]);

    const supervisor = new PollWorkerSupervisor({
      bootstrap: BOOTSTRAP,
      logger: SILENT_LOGGER,
      sink: (e) => void events.push(e),
      spawn: () => handle,
    });
    supervisor.start();
    await Bun.sleep(20);
    supervisor.stop();

    expect(events).toHaveLength(1);
  });

  test("stop() kills the worker and is idempotent", () => {
    const handle = stubHandle([]);
    const supervisor = new PollWorkerSupervisor({
      bootstrap: BOOTSTRAP,
      logger: SILENT_LOGGER,
      sink: () => {},
      spawn: () => handle,
    });
    supervisor.start();
    supervisor.stop();
    expect(handle.killed).toBe(true);
    expect(() => supervisor.stop()).not.toThrow();
  });

  test("does not respawn after stop()", async () => {
    let spawns = 0;
    const supervisor = new PollWorkerSupervisor({
      bootstrap: BOOTSTRAP,
      logger: SILENT_LOGGER,
      sink: () => {},
      spawn: () => {
        spawns++;
        return {
          stdout: null,
          exited: Promise.resolve(1),
          kill: () => {},
        };
      },
    });
    supervisor.start();
    supervisor.stop();
    await Bun.sleep(20);
    expect(spawns).toBe(1);
  });

  test("start() after stop() stays stopped", () => {
    let spawns = 0;
    const supervisor = new PollWorkerSupervisor({
      bootstrap: BOOTSTRAP,
      logger: SILENT_LOGGER,
      sink: () => {},
      spawn: () => {
        spawns++;
        return { stdout: null, exited: new Promise<number>(() => {}), kill: () => {} };
      },
    });
    supervisor.stop();
    supervisor.start();
    expect(spawns).toBe(0);
  });
});
