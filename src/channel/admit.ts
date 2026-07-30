/**
 * Sender admission for inbound messages.
 *
 * **This is a stopgap, not the admission policy.** The canonical path is the
 * gateway's: trust classification against `actorExternalId`, then the
 * per-channel admission floor. The host's channel pipeline does not accept
 * plugin-supplied inbound yet, so a message that reaches the agent loop from
 * here has bypassed all of it. Until that lands, this is the only thing between
 * a stranger's text and the assistant, and it is deliberately narrow.
 *
 * The rule: **the sender must already be a contact the user knows, in good
 * standing.** Not an allowlist the plugin maintains — the user's actual
 * contacts, so there is one place to add and remove people and no second list
 * to drift.
 *
 * Everything here fails closed. A lookup that cannot answer is a refusal.
 */

import { findContactByChannelAddress } from "../host-contacts.ts";
import type { HostContactMatch } from "../host-contacts.ts";

/**
 * Contact-channel types to try, in order.
 *
 * `imessage` first for when the contact vocabulary grows one; `phone` because
 * that is where an E.164 handle lives today, and matching it means a user who
 * already has someone in contacts needs no extra setup. The same human reached
 * by text and by call is one contact, not two.
 */
const LOOKUP_CHANNEL_TYPES = ["imessage", "phone"] as const;

/**
 * Channel statuses that may reach the agent loop.
 *
 * Only `active`. `pending` and `unverified` are known-but-unproven, `revoked`
 * and `blocked` are explicit refusals, and `undefined` means the gateway could
 * not be reached — unknown standing, which is not good standing.
 */
const ADMITTED_STATUSES = new Set(["active"]);

export type AdmitDecision =
  | { admit: true; contact: HostContactMatch }
  | { admit: false; reason: string };

export interface AdmitOptions {
  /** Normalized E.164 handle of the sender. */
  actorExternalId: string;
  /** Injectable for tests. */
  lookup?: typeof findContactByChannelAddress;
}

/**
 * Decide whether a sender may reach the agent loop.
 *
 * The reason on a refusal is for the daemon log, not for the sender: replying
 * "you are not a contact" to an unknown number confirms the line is live and
 * answers a stranger, which is exactly what an unadmitted sender should not
 * get. Callers drop silently.
 */
export async function admitSender(
  opts: AdmitOptions,
): Promise<AdmitDecision> {
  const lookup = opts.lookup ?? findContactByChannelAddress;

  for (const channelType of LOOKUP_CHANNEL_TYPES) {
    let match: HostContactMatch | null;
    try {
      match = await lookup(channelType, opts.actorExternalId);
    } catch (err) {
      // A lookup that threw tells us nothing about the sender, so it cannot be
      // read as permission.
      return {
        admit: false,
        reason: `contact lookup failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (!match) continue;

    if (match.status === undefined) {
      return {
        admit: false,
        reason:
          "contact channel status is unknown (gateway unreachable); refusing rather than assuming good standing",
      };
    }

    if (!ADMITTED_STATUSES.has(match.status)) {
      return {
        admit: false,
        reason: `contact channel status is "${match.status}"`,
      };
    }

    return { admit: true, contact: match };
  }

  return { admit: false, reason: "sender is not a known contact" };
}
