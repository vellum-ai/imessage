/**
 * Comms client for the `imessage` skill's scripts.
 *
 * Runs as a standalone bun process, so it cannot reach plugin state or the
 * in-process credential API. The API key is resolved at runtime via
 * `assistant credentials reveal` and never read from an environment variable:
 * an env var holding the key would leak through the assistant's bash tool.
 *
 * Rendering rules (markdown flattening, chunking, idempotency keys) are
 * imported from `src/channel/render.ts` rather than reimplemented, so a
 * skill-script send and a channel-reply send format identically. That module is
 * dependency-free for exactly this reason.
 */

import { execFileSync } from "node:child_process";

import {
  chunkForDelivery,
  idempotencyKey,
} from "../../../src/channel/render.ts";

const COMMS_API_BASE = "https://osis.co/api/v1/comms";

/** Human-facing credential name. The CLI takes service and field separately. */
const CREDENTIAL_SERVICE = "imessage";
const CREDENTIAL_FIELD = "api_key";

/** E.164: a leading `+` then 7 to 15 digits. */
const E164_RE = /^\+[1-9]\d{6,14}$/;

export interface SentChunk {
  id: string;
  body: string;
}

/**
 * Resolve the Comms API key from the credential store.
 *
 * `execFileSync` rather than `execSync` so nothing here goes through a shell.
 */
export function getApiKey(): string {
  try {
    const key = execFileSync(
      "assistant",
      [
        "credentials",
        "reveal",
        "--service",
        CREDENTIAL_SERVICE,
        "--field",
        CREDENTIAL_FIELD,
      ],
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
    if (!key) throw new Error("empty credential");
    return key;
  } catch {
    throw new Error(
      "No Comms API key found in the credential store.\n" +
        `Store one with: assistant credentials set --service ${CREDENTIAL_SERVICE} ` +
        `--field ${CREDENTIAL_FIELD} <your_key>\n` +
        "Load the imessage-setup skill to walk through getting a key.",
    );
  }
}

/**
 * Normalize a handle to E.164, or throw with what is wrong.
 *
 * Only the unambiguous cases are normalized: an already-E.164 number, and a
 * bare 10- or 11-digit North American number. Anything else is rejected rather
 * than guessed at, because guessing a country code is how one person ends up
 * as two contacts.
 */
export function normalizeRecipient(raw: string): string {
  const trimmed = raw.trim();
  if (E164_RE.test(trimmed)) return trimmed;

  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;

  throw new Error(
    `"${raw}" is not a recipient this channel can address. ` +
      "Use E.164, e.g. +15551234567.",
  );
}

/**
 * Send one message body, already chunked and flattened.
 *
 * Always carries an idempotency key: a retried send after a timeout delivers
 * twice, and on a real phone line the recipient sees both.
 */
async function sendOne(
  apiKey: string,
  to: string,
  body: string,
  channel: string | undefined,
  sequence: number,
): Promise<string> {
  const response = await fetch(`${COMMS_API_BASE}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey(to, body, sequence),
    },
    body: JSON.stringify({
      to,
      body,
      ...(channel ? { channel } : {}),
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Comms rejected the send (${response.status}): ${detail.slice(0, 300)}`,
    );
  }

  const parsed = (await response.json().catch(() => ({}))) as {
    message?: { id?: unknown };
  };
  const id = parsed.message?.id;
  return typeof id === "string" ? id : "";
}

export interface SendOptions {
  to: string;
  body: string;
  /** Force `sms` or `imessage`; omit to let Comms choose. */
  channel?: string;
}

/**
 * Send a message, splitting it across chunks when it is long.
 *
 * Stops at the first failure rather than continuing: the recipient already has
 * the earlier chunks, and pushing more after a failure delivers the reply out
 * of order.
 */
export async function sendMessage(opts: SendOptions): Promise<SentChunk[]> {
  const to = normalizeRecipient(opts.to);
  const chunks = chunkForDelivery(opts.body);
  if (chunks.length === 0) {
    throw new Error("Message body is empty after formatting.");
  }

  const apiKey = getApiKey();
  const sent: SentChunk[] = [];

  for (const [index, chunk] of chunks.entries()) {
    try {
      const id = await sendOne(apiKey, to, chunk, opts.channel, index);
      sent.push({ id, body: chunk });
    } catch (err) {
      if (sent.length > 0) {
        // Partial delivery is the dangerous case to hide: the recipient has
        // part of the reply and the assistant needs to know how much.
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Sent ${sent.length} of ${chunks.length} messages, then failed: ${reason}`,
        );
      }
      throw err;
    }
  }

  return sent;
}
