# imessage

An iMessage and SMS channel for the Vellum assistant.

## What it does

Makes the assistant reachable by text message. People text a line the
assistant listens on, and it answers over iMessage where the recipient
supports it and SMS otherwise.

## What it does not do

It does not read the user's personal iMessage account, history, or existing
threads.

## Setup

Enable the iMessage channel for the assistant. Vellum provides the line, so
there is no third-party account to create and no key to paste.

Users who want to run the channel on their own [Comms by
Osis](https://comms.osis.co) workspace can do that instead; see
`skills/imessage-setup/references/comms.md`.

## Development

```bash
bun install
bun test
bunx tsc --noEmit
```
