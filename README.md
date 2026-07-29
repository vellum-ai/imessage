# imessage

An iMessage and SMS channel for the Vellum assistant.

## What it does

Makes the assistant reachable by text message. People text a line the assistant
listens on, and it answers over iMessage where the recipient supports it and SMS
otherwise. The assistant can also send on request, via the `imessage` skill.

## What it does not do

It does not read the user's personal iMessage account, history, or existing
threads.

## Bring your own line

You supply the line. Create a [Comms by Osis](https://comms.osis.co) account,
provision a line, mint a Messages API key, and store it:

```bash
assistant credentials set --service imessage --field api_key <key>
```

There is no Vellum-provided option. Dedicated iMessage lines cost roughly
$250/line/month from the vendors that sell them, and a shared line cannot give
anyone a stable number — so bringing your own is the only shape that works
today.

The `imessage-setup` skill walks through the whole thing, including inbound.

## Development

```bash
bun install
bun test
bunx tsc --noEmit
```
