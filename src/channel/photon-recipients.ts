/**
 * Register the assistant's contact phone numbers as Photon users.
 *
 * Photon will only message people the project knows. Webhook registration
 * is the other half of bringing the line up, so this runs in the same
 * breath: a channel that can hear inbound but cannot send a setup check
 * to a known contact is not actually set up.
 *
 * Best-effort. A contacts list that cannot be read, or a single number
 * Photon refuses, must not take the webhook down with it — inbound still
 * works, and the setup skill's allow script is the way to finish by hand.
 */

import { describeError } from "../providers/error-detail.ts";
import type { MessagingProvider } from "../providers/types.ts";
import type { RuntimeContext } from "../plugin-state.ts";
import { loadContactPhoneNumbers } from "./contact-phones.ts";

export interface AllowContactsResult {
  /** Numbers Photon accepted (or already had). */
  allowed: string[];
  /** Numbers Photon refused, with its reason. */
  failed: { phone: string; reason: string }[];
  /** Why the contact list could not be read, when that is what happened. */
  listError?: string;
}

/**
 * Allow every contact phone number on this provider.
 *
 * No-op when the provider has no `allowRecipient` — Comms does not restrict
 * recipients, and calling this on it would only invent a step it does not
 * have. `listJson` is the test seam; production reads the assistant's
 * contacts via the CLI.
 */
export async function allowContactRecipients(
  provider: MessagingProvider,
  logger: RuntimeContext["logger"],
  listJson?: () => Promise<unknown>,
): Promise<AllowContactsResult> {
  if (!provider.allowRecipient) {
    return { allowed: [], failed: [] };
  }

  let phones: string[];
  try {
    phones = await loadContactPhoneNumbers(listJson);
  } catch (err) {
    const listError = describeError(err);
    logger.warn(
      { err, reason: listError, provider: provider.id },
      "imessage: could not list contacts to allow on Photon — inbound still works; allow a number by hand with the setup skill's allow script",
    );
    return { allowed: [], failed: [], listError };
  }

  const allowed: string[] = [];
  const failed: { phone: string; reason: string }[] = [];

  for (const phone of phones) {
    try {
      const result = await provider.allowRecipient(phone);
      allowed.push(result.phoneNumber);
      logger.info(
        { phone: result.phoneNumber, provider: provider.id },
        "imessage: allowed Photon recipient",
      );
    } catch (err) {
      const reason = describeError(err);
      failed.push({ phone, reason });
      logger.warn(
        { err, reason, phone, provider: provider.id },
        "imessage: could not allow Photon recipient",
      );
    }
  }

  return { allowed, failed };
}
