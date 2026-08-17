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

## Provider APIs

Both vendors have shapes that cost real time to rediscover, so they are written
down here rather than left in the code.

**Photon runs two planes with two protocols.** The control plane
(`spectrum.photon.codes`) is REST with `Basic base64(projectId:projectSecret)`,
and every response is enveloped as `{ succeed, data }` — a failure can arrive
inside a 200, so the envelope is what gets checked. It handles projects, the
token mint, webhooks, and users. The message plane
(`imessage.spectrum.photon.codes:443`) is **gRPC only** and answers 415 with an
empty body to anything else, including a bodiless `GET /`. Its REST routes are
real but belong to `imessage-server-v2-http`, a middleware Photon publishes as
software rather than hosting, so reaching the hosted plane means the vendor SDK.
`src/providers/photon/message-client.ts` is the only file that imports it.
Send, listing, and the live inbound stream all share that one gRPC channel.

**A Photon project may only message people it knows.** Anyone else is refused
at the message plane with `Target not allowed for this project`, which reads
like a bad address but is a policy answer. `POST /projects/{id}/users/`
registers a recipient; it is idempotent. The plugin calls it when the webhook
is registered (every contact phone number the assistant already knows) and from
`skills/imessage-setup/scripts/allow.ts` for a number allowed by hand. A cold
send does **not** register first — that control-plane call was blocking
messages the plane would have delivered — and only runs if `createChat` is
refused with the target-not-allowed error. A shared project allocates each user
their own `assignedPhoneNumber` out of a pool, which is the concrete reason a
shared line cannot promise anyone a stable number.

**A Photon webhook's `signingSecret` is returned once** and is never
retrievable, so a lost one means delete and re-register.

**Comms** (`osis.co/api/v1/comms`) is one REST API with bearer auth and the
scopes `comms_send` / `comms_read` / `comms_webhooks`, fixed at key creation.
It signs deliveries with `X-Osis-Signature: sha256=<hmac of the raw body>`,
using a secret returned when the webhook is registered. Its published docs
specify the message object as `{ id, body, direction }` only, so anything
beyond that is marked `UNVERIFIED` in `src/providers/comms/schemas.ts` and is
optional: a wrong guess degrades rather than drops a message.

## Development

```bash
bun install
bun test
bunx tsc --noEmit
```
