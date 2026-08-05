#!/usr/bin/env bun
/**
 * Send an iMessage or SMS.
 *
 *   bun skills/imessage/scripts/send.ts --to "+15551234567" --body "hello"
 *
 * The provider decides the transport: iMessage where the recipient supports it,
 * SMS otherwise, per recipient.
 *
 * Exits non-zero with the reason on failure so the assistant can report what
 * went wrong rather than assuming the message landed.
 */

import { sendMessage } from "./imessage-client.ts";

interface Args {
  to: string;
  body: string;
}

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith("--") || value === undefined) continue;
    flags.set(key.slice(2), value);
  }

  const to = flags.get("to");
  const body = flags.get("body");
  if (!to || !body) {
    throw new Error('Usage: send.ts --to "+15551234567" --body "your message"');
  }

  return { to, body };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sent = await sendMessage(args);

  if (sent.length === 1) {
    console.log(`Sent to ${args.to}${sent[0]?.id ? ` (${sent[0].id})` : ""}.`);
    return;
  }

  // Say how many messages the recipient actually received. One long reply
  // arriving as four bubbles is worth knowing about.
  console.log(
    `Sent to ${args.to} as ${sent.length} messages (the reply was too long for one).`,
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
