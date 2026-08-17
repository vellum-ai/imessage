#!/usr/bin/env bun
/**
 * Allow a Photon recipient without sending a message.
 *
 *   bun skills/imessage-setup/scripts/allow.ts --to "+15551234567"
 *   bun skills/imessage-setup/scripts/allow.ts --contacts
 *
 * Photon will only message people the project knows. Anyone else is refused
 * at the message plane with "Target not allowed for this project". This
 * registers the number as a project user so a later send can go through.
 *
 * `--contacts` allows every phone number already on the assistant's
 * contacts — the same set webhook registration allows when the channel
 * starts. `--to` is for a number that is not a contact yet, or for
 * re-running one by hand.
 *
 * Exits non-zero on failure so the assistant can report what went wrong
 * rather than assuming the number is now messageable.
 */

import { allowContactPhones, allowRecipient } from "./allow-client.ts";

interface Args {
  to?: string;
  contacts: boolean;
}

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key?.startsWith("--")) continue;
    const name = key.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags.set(name, true);
    } else {
      flags.set(name, next);
      i++;
    }
  }

  const to = flags.get("to");
  const contacts = flags.get("contacts") === true;

  if (typeof to === "string" && contacts) {
    throw new Error("Usage: allow.ts --to \"+15551234567\"  OR  allow.ts --contacts");
  }
  if (typeof to !== "string" && !contacts) {
    throw new Error(
      'Usage: allow.ts --to "+15551234567"  OR  allow.ts --contacts',
    );
  }

  return {
    ...(typeof to === "string" ? { to } : {}),
    contacts,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.to) {
    const allowed = await allowRecipient(args.to);
    console.log(`Allowed ${allowed.phoneNumber} on this Photon project.`);
    return;
  }

  const result = await allowContactPhones();
  if (result.allowed.length === 0 && result.failed.length === 0) {
    console.log(
      "No contact phone numbers to allow. Add a contact with a phone number, " +
        "or allow one by hand: allow.ts --to \"+15551234567\".",
    );
    return;
  }

  for (const phone of result.allowed) {
    console.log(`Allowed ${phone} on this Photon project.`);
  }
  if (result.failed.length > 0) {
    const detail = result.failed
      .map((entry) => `${entry.phone}: ${entry.reason}`)
      .join("; ");
    throw new Error(
      `Allowed ${result.allowed.length} of ${result.allowed.length + result.failed.length} contacts, then failed: ${detail}`,
    );
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
