#!/usr/bin/env bun
/**
 * Send an iMessage or SMS.
 *
 *   bun skills/imessage/scripts/send.ts --to "+15551234567" --body "hello"
 *
 * Optional `--channel sms|imessage` forces the delivery channel; omit it to let
 * Comms pick, which uses iMessage where the recipient supports it.
 *
 * Exits non-zero with the reason on failure so the assistant can report what
 * went wrong rather than assuming the message landed.
 */

import { sendMessage } from "./imessage-client.ts";

interface Args {
  to: string;
  body: string;
  channel?: "sms" | "imessage";
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
    throw new Error(
      'Usage: send.ts --to "+15551234567" --body "your message" [--channel sms|imessage]',
    );
  }

  return { to, body, ...(parseChannel(flags.get("channel")) ?? {}) };
}

/** Delivery channels `--channel` accepts, as the config field spells them. */
const CHANNELS = ["sms", "imessage"] as const;

/**
 * Validate `--channel` into the union the config field uses.
 *
 * A `find` over the accepted values rather than a chain of `!==`: narrowing a
 * `string` by excluding literals leaves it a `string`, and the cast that would
 * paper over that is the one place a typo could reach the provider.
 */
function parseChannel(
  value: string | undefined,
): { channel: (typeof CHANNELS)[number] } | undefined {
  if (value === undefined) return undefined;
  const channel = CHANNELS.find((candidate) => candidate === value);
  if (!channel) {
    throw new Error("--channel must be 'sms' or 'imessage'");
  }
  return { channel };
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
