# AGENTS.md — imessage plugin

Notes for agents (and humans) working in this repo.

## What this is

A standalone Vellum Assistant plugin (external plugin, installed via
`assistant plugins install`) that makes the assistant reachable by iMessage and
SMS.

Read this before anything else: **the assistant is reached on a line it
listens on, not on the user's own number.** This plugin does not read the
user's personal iMessage account, and no work in this repo will change that —
it is a property of how the lines are provisioned. If a task here assumes
access to `chat.db`, AppleScript, or the user's existing threads, the task
rests on a wrong premise; say so rather than building toward it.

**Bring-your-own is the shipping path.** The user creates their own Comms
account and owns the billing. A Vellum-provided line exists as a provider but is
not available: dedicated lines run about $250/line/month from the vendors that
sell them, and a shared line cannot promise anyone a stable number, so the
economics are unresolved. Do not write user-facing copy that offers it.

## Providers

The channel is provider-agnostic above `src/providers/types.ts`. Two providers:

- **`comms`** (default) — the user's own Comms by Osis workspace, API key, and
  line. Supports both webhook and poll ingress. The only one that works today.
- **`vellum`** — a platform-provided line. Webhook-only. **Not reachable:** it
  needs two platform endpoints and a host-injected `platformFetch` that do not
  exist. `resolveProvider` throws with a message naming `comms` instead. It is
  kept so the shape is not redesigned from scratch if the economics change.

The seam is also worth keeping independently of the second entry. No official
iMessage API exists; every vendor that sells lines runs a macOS fleet under an
arrangement Apple tolerates rather than licenses, and at least one competitor has
been permanently banned mid-product. A vendor getting cut off should be an
adapter swap, not a rewrite.

Adding a provider means adding a directory under `src/providers/` and a
registry entry in `src/providers/index.ts`. Nothing above the seam changes. If
a change outside `src/providers/` needs to know which provider is active,
that is the signal the seam is in the wrong place — fix the seam.

The settings app (`apps/imessage-settings/`) POSTs to `routes/provider.ts` to
switch or (re)start the channel. It disables `vellum` in the picker rather than
letting someone select a provider that only produces an idle channel, and
posting the active provider bounces its ingress — a useful way to recover a
wedged poll worker without bouncing the daemon. That path and plugin boot both
go through `startChannelRuntime` in
`src/channel-runtime.ts` — deliberately, so the two cannot drift and show up as
"it works after a restart".

`startChannelRuntime` never throws. A provider that cannot be built, or an
ingress mode the provider does not support, leaves the channel idle with a
reason the app renders. It also clears the previous provider *before* building
the new one, so a failed switch cannot leave the old provider sending under a
config that no longer names it. `vellum` is the fixture that makes those paths
testable: it is the provider that cannot be built.

## Outbound

Two callers, one set of rules.

- **The `imessage` skill** (`skills/imessage/`) is how the assistant sends
  deliberately. `scripts/send.ts` runs as a standalone bun process, so it
  resolves the API key via `assistant credentials reveal` rather than the
  in-process credential API.
- **The channel transport** (`src/channel/transport.ts`) is how a reply to an
  inbound message goes back out.

Both import `src/channel/render.ts`, which is dependency-free for exactly that
reason: a skill-script send and a channel reply must format identically, and two
copies of the rules would drift.

**Long replies are chunked, never truncated.** An earlier version cut at the
limit and appended an ellipsis, which silently dropped the end of every long
answer. Each chunk carries its own idempotency key including its **index** — a
long reply can legitimately repeat itself, and keying on the body alone had the
provider collapse the duplicate chunk and drop it.

## Ingress

Webhooks are the default. **The gateway verifies delivery signatures, enforces
body limits, and rate-limits before the route handler runs** — the plugin does
not re-implement any of that. Two verification schemes would be two things to
keep in sync and one to get subtly wrong.

Polling exists for deployments whose gateway is not reachable from the
internet. It runs in **its own worker process** (`src/worker/`), not the
daemon: a busy line or a slow provider must not compete with the assistant's
event loop, and a crash in the loop must not take the daemon down. The
supervisor restarts it with backoff.

## Inbound delivery

Both ingress modes converge on `deliverInbound` in `src/inbound.ts` — the poll
worker's sink and the webhook route call the same function, so they cannot
diverge on who gets in or how a reply goes back out. The path is: config
allowlist narrows → `admitSender` → `runConversationTurn` → bind the thread →
flatten to text → reply.

**`runConversationTurn` bypasses the gateway.** It takes no actor, no trust
class, and no channel, so an inbound message that reaches it has gone around
the `no_one` kill switch, trust classification, and the per-channel admission
floor. That is not a subtlety to rediscover later; it is the entire reason
`src/channel/admit.ts` exists.

**Admission is gated on the user's contacts, not on a list this plugin keeps.**
`admitSender` looks the sender's E.164 handle up through the host's contact API
(`findContactByChannelAddress`, tried as `imessage` then `phone`) and admits
only a match whose channel status is `active`. One place to add and remove
people, no second list to drift. Everything fails closed:

- lookup throws (including a host too old to expose it) → refuse
- `status === undefined` (gateway unreachable) → refuse; unknown standing is
  not good standing
- any non-`active` status → refuse, and **do not** fall through to the next
  channel type — a blocked `imessage` row must not be re-admitted via `phone`

This is a stopgap. When the host's channel pipeline accepts plugin-supplied
inbound, `src/inbound.ts` collapses into a call to it and `admit.ts` goes away.

**Refusals are silent to the sender.** No reply, and the route still returns
200 without the reason in the body. Answering "you are not a contact" confirms
the line is live and answers a stranger, which is what an unadmitted sender
must not get. The reason goes to the daemon log only.

**The contact lookup is reached through `src/host-contacts.ts`, not imported
directly.** It is a newer `@vellumai/plugin-api` export than the pinned
peerDependency floor, so it is resolved off the namespace at call time and its
absence throws — which `admit.ts` turns into a refusal. Delete the shim and
import directly once the floor is above the release that adds it.

**Threads are bound in `src/conversation-map.ts`**, durably under
`pluginStorageDir`, `conversationExternalId → assistant conversationId`.
Without it every text starts a fresh conversation and the assistant has amnesia
between messages. Two details are load-bearing: the map is **re-read before
every write** (the poll worker and the webhook route are separate processes, so
a cached in-memory copy in one would clobber the other's bindings), and the
bind happens **after** the first successful turn (binding an id for a turn that
then failed strands the thread on a conversation holding no messages). A
corrupt or schema-invalid map degrades to empty rather than throwing: losing
thread continuity is bad, refusing to answer at all is worse.

**A failed reply is not a failed turn.** The turn is already persisted;
retrying it would double-answer. `deliverInbound` reports the delivery failure
and does not re-run.

## Comms API facts worth not re-deriving

Base `https://osis.co/api/v1/comms`, bearer auth, scopes `comms_send` /
`comms_read` / `comms_webhooks`.

- `POST /messages` — `{ to | conversation_id, body, channel?, idempotency_key? }`.
  202 on send, **200 with `duplicate: true`** when an idempotency key collides.
  Always send a key: a retried send after a timeout delivers twice, and on a
  real phone line the recipient sees both.
- `GET /messages` — `conversation_id`, `since` (ISO-8601), `direction`, `limit`.
- `POST /webhooks` — `{ url, events }`; events include `message.received` and
  `message.sent`.

The published docs specify the message object only as `{ id, body, direction }`
and do not document the webhook envelope. Fields beyond those three are marked
`UNVERIFIED` in `src/providers/comms/schemas.ts`, are optional so a wrong guess
degrades rather than drops a message, and accept several plausible spellings.
`unknownMessageKeys()` logs wire keys the schema does not model, so one real
payload corrects the guesses.

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
- **No raw control bytes in source.** One NUL makes git classify the file as
  binary and the diff disappears from review entirely. Write control characters
  as escapes. `src/__tests__/source-hygiene.test.ts` enforces this.
- **The channel id is derived, not declared.** `CHANNEL_ID` in
  `src/plugin-paths.ts` is the plugin's directory name, because the host
  already serves this plugin at `/x/plugins/<name>/` and
  `/webhooks/plugins/<name>/`. A separate hardcoded id could only agree with
  the directory name or be a bug.
- **`CommsClient` takes no constructor arguments.** There is one Comms
  deployment and one credential it can use, so injecting either would only
  create a way for a caller to be wrong. Tests stub `fetch` and mock
  `resolveCredential` at the module level.

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
- **The poller advances past records it did not deliver.** A record that is not
  a turn still moves the cursor, or it is re-fetched on every poll forever.
- **Nothing resolves credentials at init.** The provider resolves what it needs
  at call time, so an unconfigured line costs nothing at boot and a rotated key
  takes effect without a restart.

## Checks

```
bun test
bunx tsc --noEmit
```
