/**
 * Phone numbers the assistant already knows, as Photon users.
 *
 * A Photon project may only message people it has registered. The plugin
 * registers a recipient on the first send, but a setup probe — and any
 * outbound to someone who has never texted the line — still fails with
 * "Target not allowed for this project" until they are a project user.
 *
 * The numbers worth registering are the ones on the assistant's contacts:
 * those are the people the gateway will already admit. Parsing that list
 * here, rather than asking the setup skill to re-derive it, keeps webhook
 * registration and the allow script on the same set.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { normalizeHandle, phoneFromAddress } from "./identity.ts";

const execFileAsync = promisify(execFile);

/** Channel types whose address is a phone number. */
const PHONE_CHANNEL_TYPES = new Set(["phone", "imessage", "sms", "whatsapp"]);

/** Contacts-page / prompt type for this plugin's discovered channel. */
const IMESSAGE_CHANNEL_TYPE = "imessage";

/** Inbound trust stores the same handle as `imessage:+E.164` on type `plugin`. */
const IMESSAGE_INBOUND_PREFIX = "imessage:";

/** Channel statuses that mean "do not message this person". */
const SKIP_STATUSES = new Set(["blocked", "revoked"]);

/** How long to wait for `assistant contacts list` before giving up. */
const LIST_CONTACTS_TIMEOUT_MS = 10_000;

/**
 * E.164 numbers on a contacts-list payload.
 *
 * Accepts both shapes the host actually emits: the HTTP/OpenAPI form
 * (`type` + `address`) and the CLI form the contacts skill documents
 * (`channel` + `externalUserId`). A blocked or revoked channel is skipped
 * — Photon's user list is provisioning, not an override of the gateway ACL.
 */
export function phoneNumbersFromContacts(payload: unknown): string[] {
  const contacts = contactsOf(payload);
  const phones = new Set<string>();

  for (const contact of contacts) {
    if (!contact || typeof contact !== "object") continue;
    const channels = (contact as { channels?: unknown }).channels;
    if (!Array.isArray(channels)) continue;

    for (const channel of channels) {
      const phone = phoneFromChannel(channel);
      if (phone) phones.add(phone);
    }
  }

  return [...phones];
}

/**
 * Load the assistant's contact phone numbers.
 *
 * `listJson` is the test seam. The default shells out to
 * `assistant contacts list --json`, which is the same command the contacts
 * skill uses — so a number this returns is a number the gateway already
 * knows, not a second copy of the contact book.
 */
export async function loadContactPhoneNumbers(
  listJson: () => Promise<unknown> = listContactsJson,
): Promise<string[]> {
  return phoneNumbersFromContacts(await listJson());
}

/** `assistant contacts list --json`, parsed. */
export async function listContactsJson(
  extraArgs: readonly string[] = [],
): Promise<unknown> {
  let stdout: string;
  try {
    const result = await execFileAsync(
      "assistant",
      ["contacts", "list", "--json", "--limit", "100", ...extraArgs],
      { timeout: LIST_CONTACTS_TIMEOUT_MS, encoding: "utf8" },
    );
    stdout = result.stdout;
  } catch (err) {
    const detail =
      err instanceof Error
        ? (err as { stderr?: string }).stderr?.trim() || err.message
        : String(err);
    throw new Error(
      `assistant contacts list failed: ${detail.slice(0, 300)}`,
    );
  }

  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    throw new Error("assistant contacts list returned a body that is not JSON");
  }
}

/** Guardian contacts only. The setup skill uses this before prompting. */
export async function listGuardianContactsJson(): Promise<unknown> {
  return listContactsJson(["--role", "guardian"]);
}

/**
 * The first usable phone number on the guardian contact, if any.
 *
 * `listJson` is the test seam. Production reads
 * `assistant contacts list --role guardian --json`.
 */
export async function loadGuardianPhoneNumber(
  listJson: () => Promise<unknown> = listGuardianContactsJson,
): Promise<string | undefined> {
  return phoneNumbersFromContacts(await listJson())[0];
}

/** A guardian iMessage handle already on the contact graph. */
export interface GuardianImessageIdentity {
  address: string;
  verified: boolean;
}

/**
 * The guardian's iMessage identity, if one is already stored.
 *
 * Looks at type `imessage` and at the inbound `(plugin, imessage:…)` row.
 * A Phone Calling number does not count: inbound trust is a different
 * (type, address) key, so a verified phone is still unknown on iMessage.
 *
 * `listJson` is the test seam. Production reads
 * `assistant contacts list --role guardian --json`.
 */
export async function loadGuardianImessageIdentity(
  listJson: () => Promise<unknown> = listGuardianContactsJson,
): Promise<GuardianImessageIdentity | undefined> {
  return imessageIdentityFromContacts(await listJson());
}

/**
 * First iMessage identity on a contacts-list payload.
 *
 * Prefers a verified row when both an unverified discovered channel and a
 * verified inbound row exist. Same HTTP and CLI channel shapes as
 * {@link phoneNumbersFromContacts}.
 */
export function imessageIdentityFromContacts(
  payload: unknown,
): GuardianImessageIdentity | undefined {
  const contacts = contactsOf(payload);
  let fallback: GuardianImessageIdentity | undefined;

  for (const contact of contacts) {
    if (!contact || typeof contact !== "object") {
      continue;
    }
    const channels = (contact as { channels?: unknown }).channels;
    if (!Array.isArray(channels)) {
      continue;
    }

    for (const channel of channels) {
      const identity = imessageIdentityFromChannel(channel);
      if (!identity) {
        continue;
      }
      if (identity.verified) {
        return identity;
      }
      if (!fallback) {
        fallback = identity;
      }
    }
  }

  return fallback;
}

function contactsOf(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  const contacts = (payload as { contacts?: unknown }).contacts;
  return Array.isArray(contacts) ? contacts : [];
}

function imessageIdentityFromChannel(
  channel: unknown,
): GuardianImessageIdentity | undefined {
  if (!channel || typeof channel !== "object") {
    return undefined;
  }
  const row = channel as {
    status?: unknown;
    policy?: unknown;
    type?: unknown;
    channel?: unknown;
    address?: unknown;
    externalUserId?: unknown;
    externalChatId?: unknown;
  };

  const status = typeof row.status === "string" ? row.status.toLowerCase() : "";
  if (SKIP_STATUSES.has(status)) {
    return undefined;
  }
  if (typeof row.policy === "string" && row.policy.toLowerCase() === "deny") {
    return undefined;
  }

  const kind =
    typeof row.type === "string"
      ? row.type.toLowerCase()
      : typeof row.channel === "string"
        ? row.channel.toLowerCase()
        : "";
  const isDiscovered = kind === IMESSAGE_CHANNEL_TYPE;
  const isInbound = kind === "plugin";
  if (!isDiscovered && !isInbound) {
    return undefined;
  }

  const candidates = [row.address, row.externalUserId, row.externalChatId];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") {
      continue;
    }
    const handle = handleFromImessageAddress(candidate, isInbound);
    if (!handle) {
      continue;
    }
    return { address: handle, verified: channelLooksVerified(status) };
  }
  return undefined;
}

function handleFromImessageAddress(
  raw: string,
  requirePrefix: boolean,
): string | undefined {
  const trimmed = raw.trim();
  const prefixed = trimmed.toLowerCase().startsWith(IMESSAGE_INBOUND_PREFIX);
  if (requirePrefix && !prefixed) {
    return undefined;
  }
  const unscoped = prefixed
    ? trimmed.slice(IMESSAGE_INBOUND_PREFIX.length)
    : trimmed;
  return normalizeHandle(unscoped);
}

function channelLooksVerified(status: string): boolean {
  return status === "verified" || status === "active";
}

function phoneFromChannel(channel: unknown): string | undefined {
  if (!channel || typeof channel !== "object") return undefined;
  const row = channel as {
    status?: unknown;
    policy?: unknown;
    type?: unknown;
    channel?: unknown;
    address?: unknown;
    externalUserId?: unknown;
    externalChatId?: unknown;
  };

  const status = typeof row.status === "string" ? row.status.toLowerCase() : "";
  if (SKIP_STATUSES.has(status)) return undefined;
  if (typeof row.policy === "string" && row.policy.toLowerCase() === "deny") {
    return undefined;
  }

  const kind =
    typeof row.type === "string"
      ? row.type
      : typeof row.channel === "string"
        ? row.channel
        : "";
  if (kind && !PHONE_CHANNEL_TYPES.has(kind.toLowerCase())) return undefined;

  const candidates = [row.address, row.externalUserId, row.externalChatId];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const phone = phoneFromAddress(candidate);
    if (phone) return phone;
  }
  return undefined;
}
