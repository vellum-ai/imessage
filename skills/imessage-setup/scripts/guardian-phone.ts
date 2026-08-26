#!/usr/bin/env bun
/**
 * Report whether the guardian contact already has a phone number.
 *
 *   bun skills/imessage-setup/scripts/guardian-phone.ts
 *
 * Prints one JSON object: `{ "found": true, "phone": "+15551234567" }`
 * or `{ "found": false }`. The setup skill uses this to decide whether
 * to open `assistant contacts prompt`.
 */

import { loadGuardianPhoneNumber } from "../../../src/channel/contact-phones.ts";

async function main(): Promise<void> {
  const phone = await loadGuardianPhoneNumber();
  if (phone) {
    console.log(JSON.stringify({ found: true, phone }));
    return;
  }
  console.log(JSON.stringify({ found: false }));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
