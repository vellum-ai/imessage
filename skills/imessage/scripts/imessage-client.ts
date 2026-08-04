/**
 * Outbound client for the `imessage` skill's scripts.
 *
 * Runs as a standalone bun process, so it cannot reach plugin state, the
 * provider seam, or the in-process credential API — anything under
 * `src/providers/` imports `@vellumai/plugin-api`, which only resolves inside
 * the daemon. Credentials are resolved at runtime via `assistant credentials
 * reveal` and never read from an environment variable: an env var holding a key
 * would leak through the assistant's bash tool.
 *
 * That is why the wire calls are written twice — once here against the CLI, and
 * once in `src/providers/` against the in-process API. The alternative is a
 * credential seam threaded through every adapter so both callers can share one
 * client, which is worth doing when a third caller appears and is not worth it
 * for two.
 *
 * Rendering rules (markdown flattening, chunking, idempotency keys) are
 * imported from `src/channel/render.ts` rather than reimplemented, so a
 * skill-script send and a channel-reply send format identically. That module is
 * dependency-free for exactly this reason.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  chunkForDelivery,
  idempotencyKey,
} from "../../../src/channel/render.ts";

const COMMS_API_BASE = "https://osis.co/api/v1/comms";
const PHOTON_CLOUD_BASE = "https://spectrum.photon.codes";
const PHOTON_IMESSAGE_BASE = "https://imessage.spectrum.photon.codes";

/** Human-facing credential name. The CLI takes service and field separately. */
const CREDENTIAL_SERVICE = "imessage";
const CREDENTIAL_FIELD = "api_key";

/** E.164: a leading `+` then 7 to 15 digits. */
const E164_RE = /^\+[1-9]\d{6,14}$/;

/**
 * Which provider the channel is configured for.
 *
 * `config.json` is read directly rather than through `src/config.ts`, which
 * would drag in `@vellumai/plugin-api` for a value that is one `JSON.parse`
 * away. A missing or unreadable file reads as the plugin's own default, which
 * has to stay in step with the schema's — the check below fails loudly rather
 * than sending over a line the user did not configure.
 */
export const DEFAULT_PROVIDER = "photon";

function configuredProvider(): string {
  const configPath = join(
    new URL(".", import.meta.url).pathname,
    "..",
    "..",
    "..",
    "config.json",
  );

  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf-8"));
    if (parsed && typeof parsed === "object") {
      const configured = (parsed as { provider?: unknown }).provider;
      if (typeof configured === "string" && configured.length > 0) {
        return configured;
      }
    }
  } catch {
    // No config, or an unreadable one: the plugin's own default applies.
  }
  return DEFAULT_PROVIDER;
}

/** One credential, straight from the store. No shell is involved. */
function revealCredential(field: string): string {
  try {
    const value = execFileSync(
      "assistant",
      ["credentials", "reveal", "--service", CREDENTIAL_SERVICE, "--field", field],
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
    if (!value) throw new Error("empty credential");
    return value;
  } catch {
    throw new Error(
      `No ${CREDENTIAL_SERVICE}:${field} credential found.\n` +
        `Store one with: assistant credentials set --service ${CREDENTIAL_SERVICE} ` +
        `--field ${field} <value>\n` +
        "Load the imessage-setup skill to walk through getting one.",
    );
  }
}

export interface SentChunk {
  id: string;
  body: string;
}

/** Resolve the Comms API key from the credential store. */
export function getApiKey(): string {
  return revealCredential(CREDENTIAL_FIELD);
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

/**
 * Mint a message-plane token and resolve the chat to send into.
 *
 * Photon splits into a control plane that authenticates with the project pair
 * and a message plane that takes a short-lived token minted from it, and it
 * addresses conversations by chat guid rather than by phone number. Both hops
 * happen once per send rather than once per chunk.
 */
async function openPhotonChat(to: string): Promise<{
  token: string;
  instanceId?: string;
  chatGuid: string;
}> {
  const projectId = revealCredential("photon_project_id");
  const secret = revealCredential("photon_project_secret");
  const auth = `Basic ${btoa(`${projectId}:${secret}`)}`;

  const minted = await fetch(
    `${PHOTON_CLOUD_BASE}/projects/${encodeURIComponent(projectId)}/imessage/tokens`,
    { method: "POST", headers: { Authorization: auth } },
  );
  if (!minted.ok) {
    throw new Error(
      `Photon refused to issue a token (${minted.status}). Check the project ID and secret.`,
    );
  }

  // `{ succeed, data }` — a failure can arrive inside a 200, so the envelope
  // is what decides, not the status.
  const envelope = (await minted.json().catch(() => ({}))) as {
    succeed?: boolean;
    message?: string;
    data?: {
      type?: string;
      token?: string;
      auth?: Record<string, string>;
    };
  };
  if (!envelope.succeed) {
    throw new Error(
      `Photon refused to issue a token: ${envelope.message ?? "no reason given"}`,
    );
  }

  // Dedicated projects mint one token per instance; this script drives a
  // single line, so it takes the first and routes to it.
  const dedicated = Object.entries(envelope.data?.auth ?? {})[0];
  const token = envelope.data?.token ?? dedicated?.[1];
  if (!token) {
    throw new Error(
      "Photon issued no iMessage token — check that the project has an active line.",
    );
  }
  const instanceId = envelope.data?.token ? undefined : dedicated?.[0];

  const chat = await fetch(`${PHOTON_IMESSAGE_BASE}/v1/chats`, {
    method: "POST",
    headers: photonHeaders(token, instanceId),
    // `service: 1` is CHAT_SERVICE_TYPE_IMESSAGE. Creating resolves the
    // existing chat for a participant rather than duplicating it.
    body: JSON.stringify({ addresses: [to], service: 1 }),
  });
  if (!chat.ok) {
    const detail = await chat.text().catch(() => "");
    throw new Error(
      `Photon could not open a chat with ${to} (${chat.status}): ${detail.slice(0, 300)}`,
    );
  }

  const chatGuid = (
    (await chat.json().catch(() => ({}))) as { chat?: { guid?: unknown } }
  ).chat?.guid;
  if (typeof chatGuid !== "string" || chatGuid.length === 0) {
    throw new Error(`Photon returned no chat guid for ${to}, so nothing was sent.`);
  }

  return { token, instanceId, chatGuid };
}

function photonHeaders(
  token: string,
  instanceId: string | undefined,
): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    ...(instanceId ? { "x-photon-server": instanceId } : {}),
  };
}

/** One chunk over Photon's message plane. */
async function sendOnePhoton(
  chat: { token: string; instanceId?: string; chatGuid: string },
  to: string,
  body: string,
  sequence: number,
): Promise<string> {
  const key = idempotencyKey(to, body, sequence);
  const response = await fetch(`${PHOTON_IMESSAGE_BASE}/v1/messages:sendText`, {
    method: "POST",
    headers: { ...photonHeaders(chat.token, chat.instanceId), "x-idempotency-key": key },
    body: JSON.stringify({
      chatGuid: chat.chatGuid,
      text: body,
      clientMessageId: key,
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Photon rejected the send (${response.status}): ${detail.slice(0, 300)}`,
    );
  }

  const guid = (
    (await response.json().catch(() => ({}))) as { message?: { guid?: unknown } }
  ).message?.guid;
  return typeof guid === "string" ? guid : "";
}

export interface SendOptions {
  to: string;
  body: string;
  /** Force `sms` or `imessage`; omit to let Comms choose. Comms only. */
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
  const provider = configuredProvider();
  const to = normalizeRecipient(opts.to);
  const chunks = chunkForDelivery(opts.body);
  if (chunks.length === 0) {
    throw new Error("Message body is empty after formatting.");
  }

  // Resolved once, before the first chunk: a credential prompt or a token mint
  // between chunks would leave the recipient with half a reply.
  const send = await openSender(provider, to, opts.channel);
  const sent: SentChunk[] = [];

  for (const [index, chunk] of chunks.entries()) {
    try {
      const id = await send(chunk, index);
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

/** How one chunk gets delivered, with everything provider-specific resolved. */
type ChunkSender = (body: string, sequence: number) => Promise<string>;

/**
 * Bind a sender for the configured provider.
 *
 * An unknown provider throws rather than falling back: sending over a line the
 * user did not configure is worse than not sending, and it is the failure that
 * looks like success until someone checks the wrong dashboard.
 */
async function openSender(
  provider: string,
  to: string,
  channel: string | undefined,
): Promise<ChunkSender> {
  if (provider === "comms") {
    const apiKey = getApiKey();
    return (body, sequence) => sendOne(apiKey, to, body, channel, sequence);
  }

  if (provider === "photon") {
    const chat = await openPhotonChat(to);
    return (body, sequence) => sendOnePhoton(chat, to, body, sequence);
  }

  throw new Error(
    `The iMessage channel is configured for the "${provider}" provider, which this ` +
      "script does not know how to send over.",
  );
}
