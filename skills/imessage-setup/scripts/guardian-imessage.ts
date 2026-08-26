#!/usr/bin/env bun
/**
 * Report whether the guardian contact already has an iMessage identity.
 *
 *   bun skills/imessage-setup/scripts/guardian-imessage.ts
 *
 * Prints one JSON object:
 *   `{ "found": true, "address": "+15551234567", "verified": true }`
 *   `{ "found": true, "address": "+15551234567", "verified": false }`
 *   `{ "found": false, "suggested": "+15551234567" }`
 *   `{ "found": false }`
 *
 * A Phone Calling number is not an iMessage identity. `suggested` is that
 * phone when present, so the setup skill can prefill the iMessage prompt.
 * The skip check is `found && verified`.
 */

import {
  loadGuardianImessageIdentity,
  loadGuardianPhoneNumber,
} from "../../../src/channel/contact-phones.ts";

async function main(): Promise<void> {
  const identity = await loadGuardianImessageIdentity();
  if (identity) {
    console.log(
      JSON.stringify({
        found: true,
        address: identity.address,
        verified: identity.verified,
      }),
    );
    return;
  }

  const suggested = await loadGuardianPhoneNumber();
  if (suggested) {
    console.log(JSON.stringify({ found: false, suggested }));
    return;
  }
  console.log(JSON.stringify({ found: false }));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
