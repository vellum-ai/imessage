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

Bringing your own is the only option that works today. A Vellum-provided line
exists in the code as a `vellum` provider but is not available: dedicated lines
cost roughly $250/line/month from the vendors that sell them, and a shared line
cannot give anyone a stable number, so the economics are unresolved.

The `imessage-setup` skill walks through the whole thing, including inbound.

## Who can text it

Only people who are already contacts of the assistant, with an `active` channel
for the number they text from. Anyone else is dropped silently — no reply, so
the sender cannot tell the line is live. There is no separate allowlist to
maintain; the contact graph is the list.

That is deliberately narrower than the assistant's normal admission policy,
because inbound here runs the agent loop directly rather than through the
gateway. It fails closed: an unreadable contact status is a refusal, not an
admission.

## Development

```bash
bun install
bun test
bunx tsc --noEmit
```
