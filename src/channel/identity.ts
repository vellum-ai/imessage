/**
 * Handle normalization and the actor/conversation split.
 *
 * Two rules the rest of the plugin depends on:
 *
 * 1. **Actor is not conversation.** `actorExternalId` (who sent it) drives
 *    trust classification and admission; `conversationExternalId` (where it
 *    landed) drives conversation binding. Conflating them is the bug the
 *    gateway's channel-identity vocabulary exists to prevent. On a 1:1 SMS
 *    thread they look interchangeable, which is exactly why the mistake
 *    survives review.
 *
 * 2. **One human, one id.** The same person can reach a Comms line from a
 *    number written half a dozen ways. Every handle is normalized to E.164
 *    before it is used as an identity, or the same human gets two contact
 *    records and two trust classifications.
 */

/** Default country calling code for bare national numbers. */
const DEFAULT_COUNTRY_CODE = "1";

/**
 * Normalize a handle to E.164 (`+` followed by 7 to 15 digits).
 *
 * Accepts the formats a Comms line realistically sees: already-E.164
 * (`+15551234567`), US national with punctuation (`(555) 123-4567`), and
 * international-prefixed (`011...`, `00...`). Returns `undefined` for anything
 * it cannot confidently normalize — the caller must fail closed rather than
 * fall back to the raw string, since a raw handle used as an identity is a
 * contact record that will never match again.
 *
 * Email-style Apple IDs are returned lowercased and otherwise untouched: a
 * Comms line is a phone line, so these are not expected, but silently
 * mangling one into a bad phone number would be worse than passing it through.
 */
export function normalizeHandle(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;

  if (trimmed.includes("@")) {
    return isPlausibleEmail(trimmed) ? trimmed.toLowerCase() : undefined;
  }

  const hadPlus = trimmed.startsWith("+");
  let digits = trimmed.replace(/\D/g, "");
  if (digits.length === 0) return undefined;

  if (!hadPlus) {
    // International access prefixes: strip so the rest reads as a country
    // code. Checked before the national-number branch because `011` and `00`
    // are never the start of an E.164 country code.
    if (digits.startsWith("011")) {
      digits = digits.slice(3);
    } else if (digits.startsWith("00")) {
      digits = digits.slice(2);
    } else if (digits.length === 10) {
      // Bare national number. Only assume a country for the canonical
      // 10-digit case; anything else is ambiguous and better rejected.
      digits = `${DEFAULT_COUNTRY_CODE}${digits}`;
    } else if (
      digits.length === 11 &&
      digits.startsWith(DEFAULT_COUNTRY_CODE)
    ) {
      // Already country-coded, just missing the `+`.
    } else {
      return undefined;
    }
  }

  // E.164 allows at most 15 digits; below 7 is not a dialable subscriber
  // number. Short codes fall outside this range on purpose: they are not
  // people and must not become contact identities.
  if (digits.length < 7 || digits.length > 15) return undefined;

  return `+${digits}`;
}

/**
 * A phone number this channel can address, pulled from a handle or a chat guid.
 *
 * Photon keys a 1:1 chat as `any;-;+15551234567`. Setup and the allow script
 * both see that spelling as often as a bare E.164, and Photon's user API
 * wants the phone, not the guid. Email-style Apple IDs are not a Photon user
 * and are dropped rather than posted as a phone number.
 */
export function phoneFromAddress(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  const handle = trimmed.includes(";")
    ? (trimmed.split(";").at(-1) ?? "")
    : trimmed;
  const normalized = normalizeHandle(handle);
  if (!normalized || normalized.includes("@")) return undefined;
  return normalized;
}

function isPlausibleEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/** Identity fields the normalizer stamps onto an inbound event. */
export interface ResolvedIdentity {
  /** Who sent it. Drives trust and admission. */
  actorExternalId: string;
  /** Where it landed. Drives conversation binding. */
  conversationExternalId: string;
}

export interface ResolveIdentityInput {
  /** Sender handle as Comms reported it. */
  from: string | undefined;
  /** Comms conversation id, when the payload carried one. */
  conversationId: string | undefined;
}

/**
 * Resolve the identity pair, or `undefined` when the message cannot be
 * attributed to a sender.
 *
 * A message with no usable sender handle is dropped rather than admitted with
 * a placeholder actor: an unattributable message cannot be trust-classified,
 * and fail-closed is the only safe reading.
 *
 * When Comms omits the conversation id, the normalized handle stands in as the
 * conversation address. That is correct for a 1:1 phone thread, which is what
 * a Comms line carries, and it keeps the two ids semantically distinct even
 * when they hold the same string.
 */
export function resolveIdentity(
  input: ResolveIdentityInput,
): ResolvedIdentity | undefined {
  const actorExternalId = normalizeHandle(input.from);
  if (!actorExternalId) return undefined;

  const conversationExternalId =
    input.conversationId && input.conversationId.length > 0
      ? input.conversationId
      : actorExternalId;

  return { actorExternalId, conversationExternalId };
}
