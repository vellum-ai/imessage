import { describe, expect, test } from "bun:test";

import {
  createTransport,
  flattenForPlainText,
  idempotencyKey,
  targetFor,
} from "../channel/transport.ts";
import type {
  MessagingProvider,
  SendResult,
  SendTarget,
} from "../providers/types.ts";

interface RecordedSend {
  target: SendTarget;
  body: string;
  idempotencyKey: string;
}

function stubProvider(send?: () => Promise<SendResult>): {
  provider: MessagingProvider;
  sends: RecordedSend[];
  typing: boolean[];
} {
  const sends: RecordedSend[] = [];
  const typing: boolean[] = [];
  const provider: MessagingProvider = {
    id: "comms",
    label: "stub",
    supportsPolling: true,
    supportsLive: false,
    async checkReadiness() {
      return { ready: true };
    },
    async fetchInbound() {
      return [];
    },
    async ensureWebhook() {
      return { created: false };
    },
    async send(target, body, opts) {
      sends.push({ target, body, idempotencyKey: opts.idempotencyKey });
      return send ? await send() : { id: "msg_out" };
    },
    async setTyping(_target, isTyping) {
      typing.push(isTyping);
    },
    classifyWebhook() {
      return { kind: "ignored" as const, reason: "stub" };
    },
  };
  return { provider, sends, typing };
}

describe("targetFor", () => {
  test("addresses an E.164 conversation id as a recipient", () => {
    expect(targetFor("+15551234567")).toEqual({ to: "+15551234567" });
  });

  test("addresses an Apple ID as a recipient", () => {
    expect(targetFor("user@example.com")).toEqual({ to: "user@example.com" });
  });

  test("addresses anything else as a conversation", () => {
    expect(targetFor("conv_abc")).toEqual({ conversationId: "conv_abc" });
    expect(targetFor("chat_abc")).toEqual({ conversationId: "chat_abc" });
  });
});

describe("idempotencyKey", () => {
  test("is stable for the same target and body", () => {
    expect(idempotencyKey("+1555", "hi")).toBe(idempotencyKey("+1555", "hi"));
  });

  test("differs across targets and bodies", () => {
    expect(idempotencyKey("+1555", "hi")).not.toBe(
      idempotencyKey("+1556", "hi"),
    );
    expect(idempotencyKey("+1555", "hi")).not.toBe(
      idempotencyKey("+1555", "ho"),
    );
  });

  test("the separator prevents a boundary collision", () => {
    // With a space separator, ("a b", "c") and ("a", "b c") hash the same
    // input, collapsing two distinct sends into one.
    expect(idempotencyKey("a b", "c")).not.toBe(idempotencyKey("a", "b c"));
  });
});

describe("flattenForPlainText", () => {
  test("strips bold, italic, and inline code", () => {
    expect(flattenForPlainText("**bold** and *italic* and `code`")).toBe(
      "bold and italic and code",
    );
  });

  test("keeps fenced code contents without the fence", () => {
    expect(flattenForPlainText("```ts\nconst x = 1;\n```")).toBe("const x = 1;");
  });

  test("keeps a link tappable", () => {
    expect(flattenForPlainText("[docs](https://example.com)")).toBe(
      "docs (https://example.com)",
    );
  });

  test("strips heading and quote markers", () => {
    expect(flattenForPlainText("## Title\n> quoted")).toBe("Title\nquoted");
  });

  test("turns bullets into a character that renders in a bubble", () => {
    expect(flattenForPlainText("- one\n- two")).toBe("• one\n• two");
  });

  test("collapses blank-line runs", () => {
    expect(flattenForPlainText("a\n\n\n\nb")).toBe("a\n\nb");
  });

  test("does not mangle a bare asterisk", () => {
    expect(flattenForPlainText("2 * 3 = 6")).toBe("2 * 3 = 6");
  });

  test("empty input stays empty", () => {
    expect(flattenForPlainText("   ")).toBe("");
  });
});

describe("transport.deliver", () => {
  test("sends flattened text with an idempotency key", async () => {
    const { provider, sends } = stubProvider();
    const transport = createTransport(provider);

    const result = await transport.deliver("conv_abc", { text: "**hello**" });

    expect(result.ok).toBe(true);
    expect(result.externalMessageId).toBe("msg_out");
    expect(sends[0]?.body).toBe("hello");
    expect(sends[0]?.target).toEqual({ conversationId: "conv_abc" });
    expect(sends[0]?.idempotencyKey).toBeTruthy();
  });

  test("routes an E.164 conversation id to a recipient send", async () => {
    const { provider, sends } = stubProvider();
    const transport = createTransport(provider);

    await transport.deliver("+15551234567", { text: "hi" });

    expect(sends[0]?.target).toEqual({ to: "+15551234567" });
  });

  test("an empty render is a success, not a failure", async () => {
    const { provider, sends } = stubProvider();
    const transport = createTransport(provider);

    expect((await transport.deliver("conv_abc", { text: "" })).ok).toBe(true);
    expect(sends).toHaveLength(0);
  });

  test("a send failure returns an error result rather than throwing", async () => {
    const { provider } = stubProvider(() => {
      throw new Error("429 rate limited");
    });
    const transport = createTransport(provider);

    const result = await transport.deliver("conv_abc", { text: "hi" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("429");
  });

  test("splits a long reply across messages instead of truncating", async () => {
    // The old behavior cut at the limit and appended an ellipsis, silently
    // dropping the end of every long answer.
    const { provider, sends } = stubProvider();
    const long = ("Sentence number one. " as string).repeat(200);

    const result = await createTransport(provider).deliver("conv_abc", {
      text: long,
    });

    expect(result.ok).toBe(true);
    expect(sends.length).toBeGreaterThan(1);
    const delivered = sends.map((s) => s.body).join(" ");
    expect(delivered).toContain("Sentence number one.");
  });

  test("each chunk carries its own idempotency key", async () => {
    // Keying on the whole reply would make chunk 2 look like a retry of
    // chunk 1 and the provider would drop it.
    const { provider, sends } = stubProvider();
    await createTransport(provider).deliver("conv_abc", {
      text: ("Sentence number one. " as string).repeat(200),
    });

    const keys = sends.map((s) => s.idempotencyKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("stops at the first failed chunk rather than sending out of order", async () => {
    let calls = 0;
    const { provider, sends } = stubProvider(async () => {
      calls++;
      if (calls === 2) throw new Error("429 rate limited");
      return { id: `msg_${calls}` };
    });

    const result = await createTransport(provider).deliver("conv_abc", {
      text: ("Sentence number one. " as string).repeat(200),
    });

    expect(result.ok).toBe(false);
    expect(sends.length).toBe(2);
  });

  test("never reads the provider id", async () => {
    // Structural check on the seam: with one provider left there is no second
    // id to swap in, so instead make reading `id` a failure. If the transport
    // ever branches on the provider, this breaks.
    const { provider, sends } = stubProvider();
    const guarded = new Proxy(provider, {
      get(target, prop, receiver) {
        if (prop === "id") throw new Error("transport read provider.id");
        return Reflect.get(target, prop, receiver);
      },
    });

    await createTransport(guarded).deliver("conv_abc", { text: "hi" });

    expect(sends[0]?.body).toBe("hi");
  });
});

describe("transport.sendTyping", () => {
  test("starts the provider typing indicator", async () => {
    const { provider, typing } = stubProvider();
    const result = await createTransport(provider).sendTyping?.("any;-;+15551234567");

    expect(result?.ok).toBe(true);
    expect(typing).toEqual([true]);
  });
});
