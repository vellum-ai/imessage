# imessage

An iMessage and SMS channel for the Vellum assistant, backed by a
[Comms by Osis](https://comms.osis.co) line.

## What it does

Gives the assistant **its own phone number**. People text that number and the
assistant answers, over iMessage where the recipient supports it and SMS
otherwise.

## What it does not do

It does not read the user's personal iMessage account, history, or existing
threads. Comms is a hosted line, not a bridge to a Mac — there is no `chat.db`
access and no AppleScript anywhere in this plugin.

## Status

The channel is wired end to end except for the last hop: inbound messages are
polled, validated, and normalized, but are **not yet handed to the assistant**.
The only way a plugin can currently post into a conversation bypasses the
gateway's trust classification and admission floor, which is not acceptable for
a surface strangers can text. The sink gets connected when the host's
channel-provider contract lands.

See `AGENTS.md` for the two open seams and for the Comms API details the
published docs leave unspecified.

## Setup

```bash
assistant credentials set --service imessage --field api_key <key>
```

The key needs `comms_send` and `comms_read`. Full walkthrough in
`skills/imessage-setup/SKILL.md`.

## Development

```bash
bun install
bun test
bunx tsc --noEmit
```
