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

You supply the line, from either of two providers:

| Provider | You need | Where |
| --- | --- | --- |
| **Photon** (default) | A project ID and project secret | [photon.codes](https://photon.codes) |
| **Comms by Osis** | A Messages API key | [comms.osis.co](https://comms.osis.co) |

Pick the provider and fill in its credentials in the plugin's settings app, or
store them from a terminal:

```bash
assistant credentials set --service imessage --field photon_project_id <id>
assistant credentials set --service imessage --field photon_project_secret <secret>
```

Bringing your own is the only option. A provider-neutral line from us is not on
offer: dedicated lines cost roughly $250/line/month from the vendors that sell
them, and a shared line cannot give anyone a stable number, so the economics are
unresolved.

The `imessage-setup` skill walks through the whole thing, including inbound.

## Development

```bash
bun install
bun test
bunx tsc --noEmit
```
