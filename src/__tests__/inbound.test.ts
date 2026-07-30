/**
 * Inbound delivery tests.
 *
 * `deliverInbound` is what actually lets a text reach the agent loop, so these
 * concentrate on the refusal paths and on what the sender can observe.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { PluginInboundEvent } from "../channel/contract.ts";
import { IMessageConfigSchema } from "../config.ts";
import { getBoundConversation } from "../conversation-map.ts";
import { deliverInbound, extractText } from "../inbound.ts";

const SILENT_LOGGER = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "imessage-inbound-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function event(overrides: Record<string, unknown> = {}): PluginInboundEvent {
  return {
    version: "v1",
    sourceChannel: "imessage",
    receivedAt: "2026-07-28T12:00:30.000Z",
    message: {
      content: "what's on my calendar?",
      conversationExternalId: "conv_abc",
      externalMessageId: "msg_01",
    },
    actor: { actorExternalId: "+15551234567" },
    source: { updateId: "msg_01", chatType: "imessage" },
    raw: {},
    ...overrides,
  } as PluginInboundEvent;
}

const ADMIT_OK = async () =>
  ({
    admit: true as const,
    contact: {
      contactId: "c1",
      displayName: "Dana",
      channelType: "phone",
      address: "+15551234567",
      status: "active",
      verifiedAt: null,
    },
  });

const ADMIT_NO = async () =>
  ({ admit: false as const, reason: "sender is not a known contact" });

function runTurnStub(text = "You have one meeting.") {
  const calls: unknown[] = [];
  const runTurn = async (opts: unknown) => {
    calls.push(opts);
    return {
      content: [{ type: "text" as const, text }],
      userMessageId: "um_1",
      conversationId: "conv_assistant_1",
    };
  };
  return { runTurn, calls };
}

function replyStub() {
  const sent: { to: string; text: string }[] = [];
  return {
    sent,
    reply: async (to: string, text: string) => {
      sent.push({ to, text });
    },
  };
}

const CONFIG = IMessageConfigSchema.parse({});

describe("deliverInbound", () => {
  test("runs the turn and sends the reply back", async () => {
    const { runTurn } = runTurnStub();
    const { reply, sent } = replyStub();

    const outcome = await deliverInbound({
      event: event(),
      config: CONFIG,
      storageDir: dir,
      logger: SILENT_LOGGER,
      reply,
      runTurn: runTurn as never,
      admit: ADMIT_OK as never,
    });

    expect(outcome.delivered).toBe(true);
    expect(sent).toEqual([
      { to: "conv_abc", text: "You have one meeting." },
    ]);
  });

  test("a refused sender never reaches the agent loop", async () => {
    const { runTurn, calls } = runTurnStub();
    const { reply, sent } = replyStub();

    const outcome = await deliverInbound({
      event: event(),
      config: CONFIG,
      storageDir: dir,
      logger: SILENT_LOGGER,
      reply,
      runTurn: runTurn as never,
      admit: ADMIT_NO as never,
    });

    expect(outcome.delivered).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("a refused sender gets no reply at all", async () => {
    // Answering "you are not a contact" confirms the line is live and replies
    // to a stranger. Refusals are silent.
    const { runTurn } = runTurnStub();
    const { reply, sent } = replyStub();

    await deliverInbound({
      event: event(),
      config: CONFIG,
      storageDir: dir,
      logger: SILENT_LOGGER,
      reply,
      runTurn: runTurn as never,
      admit: ADMIT_NO as never,
    });

    expect(sent).toHaveLength(0);
  });

  test("binds the thread so the next message continues it", async () => {
    // Without a binding every text would start a fresh conversation and the
    // assistant would have amnesia between messages.
    const { runTurn, calls } = runTurnStub();
    const { reply } = replyStub();

    const deliver = () =>
      deliverInbound({
        event: event(),
        config: CONFIG,
        storageDir: dir,
        logger: SILENT_LOGGER,
        reply,
        runTurn: runTurn as never,
        admit: ADMIT_OK as never,
      });

    await deliver();
    expect(getBoundConversation(dir, "conv_abc")).toBe("conv_assistant_1");

    await deliver();
    expect((calls[1] as { conversationId?: string }).conversationId).toBe(
      "conv_assistant_1",
    );
  });

  test("does not bind when the turn fails", async () => {
    // Binding an id for a turn that then failed would strand the thread on a
    // conversation holding no messages.
    const { reply } = replyStub();

    const outcome = await deliverInbound({
      event: event(),
      config: CONFIG,
      storageDir: dir,
      logger: SILENT_LOGGER,
      reply,
      runTurn: (async () => {
        throw new Error("model unavailable");
      }) as never,
      admit: ADMIT_OK as never,
    });

    expect(outcome.delivered).toBe(false);
    expect(getBoundConversation(dir, "conv_abc")).toBeUndefined();
  });

  test("reports a reply failure without re-running the turn", async () => {
    // The turn is persisted; retrying it would double-answer.
    const { runTurn, calls } = runTurnStub();

    const outcome = await deliverInbound({
      event: event(),
      config: CONFIG,
      storageDir: dir,
      logger: SILENT_LOGGER,
      reply: async () => {
        throw new Error("429 rate limited");
      },
      runTurn: runTurn as never,
      admit: ADMIT_OK as never,
    });

    expect(outcome.delivered).toBe(false);
    if (!outcome.delivered) expect(outcome.reason).toContain("turn ran");
    expect(calls).toHaveLength(1);
  });

  test("a turn with no text sends nothing but still counts as delivered", async () => {
    const { runTurn } = runTurnStub("");
    const { reply, sent } = replyStub();

    const outcome = await deliverInbound({
      event: event(),
      config: CONFIG,
      storageDir: dir,
      logger: SILENT_LOGGER,
      reply,
      runTurn: runTurn as never,
      admit: ADMIT_OK as never,
    });

    expect(outcome.delivered).toBe(true);
    expect(sent).toHaveLength(0);
  });

  test("the config allowlist narrows further when set", async () => {
    const { runTurn, calls } = runTurnStub();
    const { reply } = replyStub();

    const outcome = await deliverInbound({
      event: event(),
      config: IMessageConfigSchema.parse({ allowedHandles: ["+15559990000"] }),
      storageDir: dir,
      logger: SILENT_LOGGER,
      reply,
      runTurn: runTurn as never,
      admit: ADMIT_OK as never,
    });

    expect(outcome.delivered).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("extractText", () => {
  test("keeps text blocks and joins them", () => {
    expect(
      extractText([
        { type: "text", text: "one" },
        { type: "text", text: "two" },
      ] as never),
    ).toBe("one\n\ntwo");
  });

  test("drops the loop's internals", () => {
    // Forwarding tool calls or thinking to a phone would leak reasoning and
    // clutter the thread.
    expect(
      extractText([
        { type: "thinking", thinking: "hmm" },
        { type: "tool_use", id: "t1", name: "calendar", input: {} },
        { type: "text", text: "You have one meeting." },
      ] as never),
    ).toBe("You have one meeting.");
  });

  test("empty content is empty text", () => {
    expect(extractText([])).toBe("");
  });
});
