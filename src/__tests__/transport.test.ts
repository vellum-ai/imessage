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
} {
  const sends: RecordedSend[] = [];
  const provider: MessagingProvider = {
    id: "comms",
    label: "stub",
    supportsPolling: true,
    async checkReadiness() {
      return { ready: true };
    },
    async fetchInbound() {
      return [];
    },
    async send(target, body, opts) {
      sends.push({ target, body, idempotencyKey: opts.idempotencyKey });
      return send ? await send() : { id: "msg_out" };
    },
    normalizeWebhook() {
      return undefined;
    },
  };
  return { provider, sends };
}

describe("targetFor", () => {
  test("addresses an E.164 conversation id as a recipient", () => {
    expect(targetFor("+15551234567")).toEqual({ to: "+15551234567" });
  });

  test("addresses anything else as a conversation", () => {
    expect(targetFor("conv_abc")).toEqual({ conversationId: "conv_abc" });
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

  test("truncates an over-long reply with an ellipsis", () => {
    const out = flattenForPlainText("x".repeat(3000));
    expect(out.length).toBeLessThanOrEqual(1400);
    expect(out.endsWith("…")).toBe(true);
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

  test("is provider-agnostic", async () => {
    // Swapping the provider changes nothing about how a reply is rendered or
    // addressed; the transport never branches on the provider id.
    const { provider, sends } = stubProvider();
    const vellumish: MessagingProvider = { ...provider, id: "vellum" };
    await createTransport(vellumish).deliver("conv_abc", { text: "hi" });
    expect(sends[0]?.body).toBe("hi");
  });
});
