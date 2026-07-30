import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  bindConversation,
  conversationMapPath,
  getBoundConversation,
  readConversationMap,
} from "../conversation-map.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "imessage-convmap-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("conversation map", () => {
  test("an absent map reads as empty", () => {
    expect(readConversationMap(dir)).toEqual({});
    expect(getBoundConversation(dir, "conv_abc")).toBeUndefined();
  });

  test("a corrupt map degrades to empty rather than throwing", () => {
    // Losing thread continuity is bad; refusing to answer at all is worse.
    writeFileSync(conversationMapPath(dir), "{ not json", "utf8");
    expect(readConversationMap(dir)).toEqual({});
  });

  test("a schema-invalid map degrades to empty", () => {
    writeFileSync(conversationMapPath(dir), JSON.stringify({ a: 42 }), "utf8");
    expect(readConversationMap(dir)).toEqual({});
  });

  test("binds and reads back", () => {
    bindConversation(dir, "conv_abc", "assistant_1");
    expect(getBoundConversation(dir, "conv_abc")).toBe("assistant_1");
  });

  test("keeps other bindings when adding one", () => {
    // The poll worker and the webhook route are separate processes; a cached
    // in-memory copy in one would clobber the other's bindings.
    bindConversation(dir, "conv_a", "assistant_a");
    bindConversation(dir, "conv_b", "assistant_b");

    expect(getBoundConversation(dir, "conv_a")).toBe("assistant_a");
    expect(getBoundConversation(dir, "conv_b")).toBe("assistant_b");
  });

  test("rebinding replaces the previous value", () => {
    bindConversation(dir, "conv_abc", "assistant_1");
    bindConversation(dir, "conv_abc", "assistant_2");

    expect(getBoundConversation(dir, "conv_abc")).toBe("assistant_2");
  });

  test("leaves no temp file behind", () => {
    bindConversation(dir, "conv_abc", "assistant_1");
    expect(readConversationMap(dir)).toEqual({ conv_abc: "assistant_1" });
  });
});
