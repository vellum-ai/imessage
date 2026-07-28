# AGENTS.md — imessage plugin

Notes for agents (and humans) working in this repo.

## What this is

A standalone Vellum Assistant plugin (external plugin, installed via
`assistant plugins install`) that makes the assistant reachable by iMessage and
SMS through a **Comms by Osis** line.

Read this before anything else: **Comms gives the assistant its own phone
number.** It is a hosted line with a REST API, not a bridge to a Mac. This
plugin cannot read the user's personal iMessage account, and no amount of work
in this repo will change that — it is a property of the provider. If a task
here assumes access to `chat.db`, AppleScript, or the user's existing threads,
the task is based on a wrong premise; say so rather than building toward it.

## Layout (discovery is by convention)

```
hooks/init.ts          resolve config, build the client, start the poller
hooks/shutdown.ts      stop the poller
channels/ingress.json  declares the webhook route (guardian-approved before it is served)
routes/events.ts       webhook receiver, used only in `ingressMode: "webhook"`
skills/imessage-setup/ guides the user through provisioning a line and storing the key
src/channel/           the channel: contract, identity, normalize, transport, provider
src/comms/             the Comms API: client, schemas, signature verification
src/config.ts          config schema and credential resolution
src/cursor.ts          durable poll cursor
src/poller.ts          the inbound polling loop
```

There is no `register.ts` and no host stub: the plugin talks to the host only
through `@vellumai/plugin-api`. Do not reach into `assistant/src/…`.

## Two unfinished seams

Both are marked `TODO(pluggable-channels)` in the source. Neither is an
oversight.

**1. Nothing is forwarded to the host yet.** `hooks/init.ts` and
`routes/events.ts` normalize inbound messages and then log them. They do not
post into a conversation, because the only available way to do that from a
plugin (`UserRouteContext` conversation posting) bypasses the gateway's
`no_one` kill switch, trust classification, and admission floor. A channel that
strangers can text into must not open that hole. When the host's
channel-provider contract lands in `vellum-assistant`, wire the sink to it.

**2. `src/channel/contract.ts` is a placeholder.** It declares the shapes the
host will eventually export from `@vellumai/plugin-api`, mirroring
`gateway/src/channels/inbound-event.ts` and
`assistant/src/messaging/providers/channel-transport.ts`. When the real
contract ships, delete the file and re-point the imports. It is the complete
list of assumptions to reconcile.

## Comms API facts worth not re-deriving

Base `https://osis.co/api/v1/comms`, bearer auth, scopes `comms_send` /
`comms_read` / `comms_webhooks`.

- `POST /messages` — `{ to | conversation_id, body, channel?, idempotency_key? }`.
  202 on send, **200 with `duplicate: true`** when an idempotency key collides.
  Always send a key: a retried send after a timeout delivers twice, and the
  recipient sees both.
- `GET /messages` — `conversation_id`, `since` (ISO-8601), `direction`, `limit`.
- `POST /webhooks` — `{ url, events }`; events include `message.received` and
  `message.sent`.

**What the docs do not say**, and what the code therefore guesses: the full
message object beyond `{ id, body, direction }`, the webhook payload envelope,
and the webhook signature scheme. Every guess is marked `UNVERIFIED` in
`src/comms/schemas.ts` and `src/comms/signature.ts`, is optional, and degrades
rather than dropping a message. `unknownMessageKeys()` logs wire keys the
schema does not model, so a real payload corrects the guesses cheaply. Fix
those two files before trusting webhook mode.

## Conventions

- TypeScript + Bun only. Intra-repo imports use explicit `.ts` extensions (Bun
  resolves them; `tsconfig` sets `allowImportingTsExtensions`).
- Pin `@vellumai/plugin-api` as a `peerDependency`.
- Credential refs passed to `resolveCredential` use **`service/field`** (slash).
  The colon form (`imessage:api_key`) is the human-facing name for the
  `assistant credentials` CLI and error messages. Mixing them up fails to
  resolve. `resolveCredential` **throws** on a missing credential; it does not
  return empty.
- `ShutdownContext` carries no logger. Only `InitContext` does.

## Invariants worth keeping

- **Actor is not conversation.** `actorExternalId` drives trust and admission;
  `conversationExternalId` drives conversation binding. On a 1:1 phone thread
  they hold the same string, which is exactly why conflating them survives
  review.
- **Every handle is normalized to E.164 before it is an identity.** The same
  human arrives as `+15551234567`, `(555) 123-4567`, and `5551234567`. Raw
  handles mean duplicate contacts and duplicate trust classifications.
  Unnormalizable means drop, never fall back to the raw string.
- **An absent `channel` field reads as `sms`.** SMS sender IDs are spoofable,
  iMessage identities are not, so a missing signal must not buy the sender the
  stronger identity.
- **Outbound echoes are never turns.** `message.sent` and any
  `direction: "outbound"` message is dropped, or the assistant answers itself.
- **The cursor carries ids, not just a timestamp.** `since` bounds are
  whole-second and the docs do not say whether the bound is inclusive.
  Inclusive with no id set replays the boundary message forever; exclusive with
  no id set loses a second message in the same second. See `src/cursor.ts`.
- **Webhook mode with no stored secret rejects everything.** Failing closed is
  the point.

## Checks

```
bun test
bunx tsc --noEmit
```
