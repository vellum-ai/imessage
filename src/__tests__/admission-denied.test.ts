/**
 * The gateway's floor-deny notice: send the canned line, never run a turn.
 */

import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, test } from "bun:test";

import {
  ACCESS_DENIED_NOT_APPROVED_REPLY,
  handleAdmissionDeniedNotice,
} from "../admission-denied.ts";
import { IMessageConfigSchema } from "../config.ts";

const sends: { target: unknown; body: string; key: string }[] = [];
const provider = {
  send: (target: unknown, body: string, opts: { idempotencyKey: string }) => {
    sends.push({ target, body, key: opts.idempotencyKey });
    return Promise.resolve({});
  },
} as never;

function notice(overrides: Record<string, unknown> = {}) {
  return {
    reason: "admission_floor",
    plugin: "imessage",
    ingressRoute: "events-linq",
    admissionPolicy: "guardian_only",
    trustClass: "unknown",
    conversationExternalId: "+15550100",
    actorExternalId: "+15550100",
    externalMessageId: "msg-1",
    replyText: ACCESS_DENIED_NOT_APPROVED_REPLY,
    ...overrides,
  };
}

function post(body: unknown): Request {
  return new Request(
    "http://localhost/x/plugins/imessage/notices/admission-denied",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
  );
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

beforeEach(() => {
  sends.length = 0;
});

describe("handleAdmissionDeniedNotice", () => {
  const config = IMessageConfigSchema.parse({
    provider: "linq",
    ingressMode: "webhook",
  });

  test("the notice module does not import a conversation turn", () => {
    const src = readFileSync(new URL("../admission-denied.ts", import.meta.url), "utf8");
    expect(src).not.toContain("runConversationTurn");
  });

  test("sends the canned denial and does not run a turn", async () => {
    const response = await handleAdmissionDeniedNotice(post(notice()), {
      config,
      provider,
    });

    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual({ ok: true });
    expect(sends).toEqual([
      {
        target: { to: "+15550100" },
        body: ACCESS_DENIED_NOT_APPROVED_REPLY,
        key: "deny:msg-1",
      },
    ]);
  });

  test("uses the local copy when the notice omits replyText", async () => {
    await handleAdmissionDeniedNotice(post(notice({ replyText: undefined })), {
      config,
      provider,
    });

    expect(sends[0]?.body).toBe(ACCESS_DENIED_NOT_APPROVED_REPLY);
  });

  test("ignores a notice for a provider that is not configured", async () => {
    const response = await handleAdmissionDeniedNotice(post(notice()), {
      config: IMessageConfigSchema.parse({
        provider: "photon",
        ingressMode: "webhook",
      }),
      provider,
    });

    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toMatchObject({
      ignored: "provider is not configured",
    });
    expect(sends).toEqual([]);
  });

  test("rejects an unparsable body", async () => {
    const response = await handleAdmissionDeniedNotice(post("{ not json"), {
      config,
      provider,
    });

    expect(response.status).toBe(400);
    expect(sends).toEqual([]);
  });

  test("rejects a notice that is not a floor deny", async () => {
    const response = await handleAdmissionDeniedNotice(
      post(notice({ reason: "something_else" })),
      { config, provider },
    );

    expect(response.status).toBe(400);
    expect(sends).toEqual([]);
  });

  test("reports a failed send without running a turn", async () => {
    const failing = {
      send: () => Promise.reject(new Error("line is down")),
    } as never;

    const response = await handleAdmissionDeniedNotice(post(notice()), {
      config,
      provider: failing,
    });

    expect(response.status).toBe(502);
    expect(await bodyOf(response)).toMatchObject({
      error: "could not send the admission denial",
    });
  });
});
