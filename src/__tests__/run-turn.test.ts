/**
 * Running an admitted delivery as a turn, and sending the answer back.
 *
 * The gate is not represented here at all, which is the point: by the time
 * this runs the gateway has already verified, parsed, deduped and gated the
 * delivery. What is left to test is the binding the turn runs under and
 * whether the answer reaches the sender.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const turns: Record<string, unknown>[] = [];
let turnResult: Record<string, unknown> = {
  conversationId: "conv-1",
  content: [{ type: "text", text: "hi back" }],
};
mock.module("@vellumai/plugin-api", () => ({
  runConversationTurn: (options: Record<string, unknown>) => {
    turns.push(options);
    return Promise.resolve(turnResult);
  },
}));

const { runTurnForDelivery } = await import("../run-turn.ts");

const sends: { target: unknown; body: string; key: string }[] = [];
const provider = {
  send: (target: unknown, body: string, opts: { idempotencyKey: string }) => {
    sends.push({ target, body, key: opts.idempotencyKey });
    return Promise.resolve({ ok: true });
  },
} as never;

function delivery() {
  return {
    version: "v1" as const,
    sourceChannel: "imessage",
    receivedAt: new Date().toISOString(),
    message: {
      content: "hello",
      conversationExternalId: "+12025550142",
      externalMessageId: "msg-1",
    },
    actor: { actorExternalId: "+12025550142", displayName: "Ada" },
    source: { updateId: "msg-1", messageId: "msg-1" },
    raw: {},
  } as never;
}

beforeEach(() => {
  turns.length = 0;
  sends.length = 0;
  turnResult = {
    conversationId: "conv-1",
    content: [{ type: "text", text: "hi back" }],
  };
});

describe("runTurnForDelivery", () => {
  test("binds the turn the way the gateway addresses the chat", async () => {
    // One channel id covers every installed plugin, and the plugin's own name
    // rides in the prefixes. Binding under anything else would put the
    // conversation where the gateway's keys and this channel's contacts do
    // not point.
    await runTurnForDelivery({ event: delivery(), provider });

    expect(turns[0]).toMatchObject({
      channel: {
        sourceChannel: "plugin",
        externalChatId: "imessage:+12025550142",
        externalUserId: "imessage:+12025550142",
        displayName: "Ada",
      },
    });
  });

  test("sends the answer back over the provider", async () => {
    // Nothing on the assistant side speaks Comms or Photon, so a reply reaches
    // the sender through here or not at all.
    const result = await runTurnForDelivery({ event: delivery(), provider });

    expect(result.replied).toBe(true);
    expect(sends).toEqual([
      {
        target: { to: "+12025550142" },
        body: "hi back",
        key: "reply:msg-1",
      },
    ]);
  });

  test("keys the send on the message it answers", async () => {
    // A redelivery the gateway did not absorb must not put the same reply in
    // the thread twice.
    await runTurnForDelivery({ event: delivery(), provider });
    await runTurnForDelivery({ event: delivery(), provider });

    expect(sends.map((send) => send.key)).toEqual([
      "reply:msg-1",
      "reply:msg-1",
    ]);
  });

  test("sends nothing when the turn was queued", async () => {
    // The assistant is mid-turn and answers when it drains. Sending now would
    // put an empty message in the thread.
    turnResult = { conversationId: "conv-1", queued: true, content: [] };

    const result = await runTurnForDelivery({ event: delivery(), provider });

    expect(result.replied).toBe(false);
    expect(sends).toEqual([]);
  });

  test("sends nothing when the assistant said nothing", async () => {
    turnResult = { conversationId: "conv-1", content: [{ type: "tool_use" }] };

    const result = await runTurnForDelivery({ event: delivery(), provider });

    expect(result.replied).toBe(false);
    expect(sends).toEqual([]);
  });
});
