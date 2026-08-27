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
const typing: boolean[] = [];
const provider = {
  send: (target: unknown, body: string, opts: { idempotencyKey: string }) => {
    sends.push({ target, body, key: opts.idempotencyKey });
    return Promise.resolve({ ok: true });
  },
  setTyping: (_target: unknown, isTyping: boolean) => {
    typing.push(isTyping);
    return Promise.resolve();
  },
} as never;

function delivery(conversationExternalId = "+12025550142") {
  return {
    version: "v1" as const,
    sourceChannel: "imessage",
    receivedAt: new Date().toISOString(),
    message: {
      content: "hello",
      conversationExternalId,
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
  typing.length = 0;
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

  test("addresses a vendor chat id as a conversation, not a recipient", async () => {
    // Linq webhooks bind the turn to the chat id. Posting that id as `to`
    // hits the cold-send endpoint and the reply never leaves the conversation.
    const result = await runTurnForDelivery({
      event: delivery("chat_abc"),
      provider,
    });

    expect(result.replied).toBe(true);
    expect(sends).toEqual([
      {
        target: { conversationId: "chat_abc" },
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

  test("sends only the final text block", async () => {
    // Intermediate narration and tool_use blocks are not an iMessage reply.
    turnResult = {
      conversationId: "conv-1",
      content: [
        { type: "text", text: "let me check the live plugin list." },
        { type: "tool_use" },
        { type: "thinking", text: "counting" },
        { type: "text", text: "You have three plugins enabled." },
      ],
    };

    await runTurnForDelivery({ event: delivery(), provider });

    expect(sends.map((send) => send.body)).toEqual([
      "You have three plugins enabled.",
    ]);
  });

  test("shows typing before the turn and clears it after", async () => {
    await runTurnForDelivery({ event: delivery(), provider });

    expect(typing).toEqual([true, false]);
  });

  test("clears typing when the turn was queued", async () => {
    turnResult = { conversationId: "conv-1", queued: true, content: [] };

    const result = await runTurnForDelivery({ event: delivery(), provider });

    expect(result.replied).toBe(false);
    expect(sends).toEqual([]);
    expect(typing).toEqual([true, false]);
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

  test("splits a long final reply across messages", async () => {
    const long = "Sentence number one. ".repeat(200);
    turnResult = {
      conversationId: "conv-1",
      content: [{ type: "text", text: long }],
    };

    await runTurnForDelivery({ event: delivery(), provider });

    expect(sends.length).toBeGreaterThan(1);
    expect(sends[0]?.key).toBe("reply:msg-1");
    expect(sends[1]?.key).toBe("reply:msg-1:1");
    expect(sends.map((send) => send.body).join(" ")).toContain(
      "Sentence number one.",
    );
  });
});
