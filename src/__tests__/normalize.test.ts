import { describe, expect, test } from "bun:test";

import {
  chatTypeFor,
  normalizeCommsMessage,
  normalizeWebhookEvent,
} from "../providers/comms/normalize.ts";
import { CommsMessageSchema } from "../providers/comms/schemas.ts";

const RECEIVED_AT = "2026-07-28T12:00:00.000Z";

function inboundMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg_01",
    direction: "inbound",
    body: "hello there",
    channel: "imessage",
    conversation_id: "conv_abc",
    from: "+15551234567",
    to: "+15559998888",
    created_at: "2026-07-28T11:59:00.000Z",
    ...overrides,
  };
}

describe("normalizeCommsMessage", () => {
  test("maps an inbound message onto the event shape", () => {
    const event = normalizeCommsMessage(inboundMessage(), RECEIVED_AT);
    expect(event).toBeDefined();
    expect(event?.sourceChannel).toBe("imessage");
    expect(event?.message.content).toBe("hello there");
    expect(event?.message.externalMessageId).toBe("msg_01");
    expect(event?.actor.actorExternalId).toBe("+15551234567");
    expect(event?.message.conversationExternalId).toBe("conv_abc");
  });

  test("uses the caller's clock, never the provider timestamp", () => {
    // Routing untrusted time into a Date is a crash class, and receipt time is
    // the correct semantic anyway.
    const event = normalizeCommsMessage(
      inboundMessage({ created_at: "not-a-date" }),
      RECEIVED_AT,
    );
    expect(event?.receivedAt).toBe(RECEIVED_AT);
  });

  test("preserves the original payload verbatim", () => {
    const raw = inboundMessage({ some_future_field: { nested: true } });
    const event = normalizeCommsMessage(raw, RECEIVED_AT);
    expect(event?.raw).toEqual(raw);
  });

  test("normalizes the sender handle into the actor id", () => {
    const event = normalizeCommsMessage(
      inboundMessage({ from: "(555) 123-4567" }),
      RECEIVED_AT,
    );
    expect(event?.actor.actorExternalId).toBe("+15551234567");
  });

  test("drops outbound echoes", () => {
    // Feeding our own replies back would have the assistant answer itself.
    expect(
      normalizeCommsMessage(
        inboundMessage({ direction: "outbound" }),
        RECEIVED_AT,
      ),
    ).toBeUndefined();
  });

  test("drops a message with no attributable sender", () => {
    expect(
      normalizeCommsMessage(inboundMessage({ from: undefined }), RECEIVED_AT),
    ).toBeUndefined();
  });

  test("drops empty and whitespace-only bodies", () => {
    expect(
      normalizeCommsMessage(inboundMessage({ body: undefined }), RECEIVED_AT),
    ).toBeUndefined();
    expect(
      normalizeCommsMessage(inboundMessage({ body: "   " }), RECEIVED_AT),
    ).toBeUndefined();
  });

  test("drops payloads missing the required identity fields", () => {
    expect(normalizeCommsMessage({ body: "hi" }, RECEIVED_AT)).toBeUndefined();
    expect(normalizeCommsMessage(null, RECEIVED_AT)).toBeUndefined();
    expect(normalizeCommsMessage("nope", RECEIVED_AT)).toBeUndefined();
  });

  test("survives a malformed optional field instead of rejecting the message", () => {
    // Tolerant parsing: a bad `channel` collapses to undefined, and the
    // message still gets through with the conservative chat type.
    const event = normalizeCommsMessage(
      inboundMessage({ channel: 12345 }),
      RECEIVED_AT,
    );
    expect(event).toBeDefined();
    expect(event?.source.chatType).toBe("sms");
  });

  test("accepts the camelCase conversation id spelling", () => {
    const event = normalizeCommsMessage(
      inboundMessage({ conversation_id: undefined, conversationId: "conv_z" }),
      RECEIVED_AT,
    );
    expect(event?.message.conversationExternalId).toBe("conv_z");
  });

  test("falls back to the handle when no conversation id is supplied", () => {
    const event = normalizeCommsMessage(
      inboundMessage({ conversation_id: undefined }),
      RECEIVED_AT,
    );
    expect(event?.message.conversationExternalId).toBe("+15551234567");
  });
});

describe("chatTypeFor", () => {
  test("distinguishes blue from green", () => {
    expect(chatTypeFor(CommsMessageSchema.parse(inboundMessage()))).toBe(
      "imessage",
    );
    expect(
      chatTypeFor(CommsMessageSchema.parse(inboundMessage({ channel: "sms" }))),
    ).toBe("sms");
  });

  test("an absent channel reads as the more conservative sms", () => {
    // A missing signal must not buy the sender the stronger, harder-to-spoof
    // identity.
    expect(
      chatTypeFor(
        CommsMessageSchema.parse(inboundMessage({ channel: undefined })),
      ),
    ).toBe("sms");
  });
});

describe("normalizeWebhookEvent", () => {
  test("unwraps the flat envelope", () => {
    const event = normalizeWebhookEvent(
      { event: "message.received", message: inboundMessage() },
      RECEIVED_AT,
    );
    expect(event?.message.content).toBe("hello there");
  });

  test("unwraps the nested envelope", () => {
    const event = normalizeWebhookEvent(
      { event: "message.received", data: { message: inboundMessage() } },
      RECEIVED_AT,
    );
    expect(event?.message.content).toBe("hello there");
  });

  test("ignores message.sent", () => {
    expect(
      normalizeWebhookEvent(
        {
          event: "message.sent",
          message: inboundMessage({ direction: "outbound" }),
        },
        RECEIVED_AT,
      ),
    ).toBeUndefined();
  });

  test("ignores an inbound-named event carrying an outbound message", () => {
    // Belt and suspenders: the event name and the direction must agree.
    expect(
      normalizeWebhookEvent(
        {
          event: "message.received",
          message: inboundMessage({ direction: "outbound" }),
        },
        RECEIVED_AT,
      ),
    ).toBeUndefined();
  });

  test("ignores unknown event types", () => {
    expect(
      normalizeWebhookEvent(
        { event: "message.delivered", message: inboundMessage() },
        RECEIVED_AT,
      ),
    ).toBeUndefined();
  });
});
