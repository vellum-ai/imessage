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

**Bring-your-own is the only shape.** The user creates their own account with a
vendor and owns the billing, whichever provider they pick. A platform-provided
line is not on offer: dedicated lines run about $250/line/month from the vendors
that sell them, and a shared line cannot promise anyone a stable number, so the
economics are unresolved. Do not write user-facing copy that offers one.

## Providers

The channel is provider-agnostic above `src/providers/types.ts`. Two providers,
both bring-your-own:

- **`comms`** (default) — the user's own Comms by Osis workspace, API key, and
  line. One REST API, one credential, both directions.
- **`photon`** — the user's own Photon (Spectrum) project. Two hosts rather
  than one: a **control plane** at `spectrum.photon.codes` authenticated with
  `Basic base64(projectId:projectSecret)`, and a **message plane** at
  `imessage.spectrum.photon.codes` authenticated with a short-lived token
  minted from it. Every send is therefore mint-then-call; the token is cached
  until shortly before it expires, and a 401 drops it and retries once. All of
  that lives in `src/providers/photon/client.ts` and nothing above the seam
  knows there are two hosts.

Photon addresses a conversation by **chat guid** (`any;-;+15551234567`), not by
phone number. A reply already has one — the webhook's `space.id` is exactly
that guid — so only a cold send to a bare handle resolves a chat first, and
that resolution carries the message with it rather than paying two round trips.

Photon ships an official SDK that speaks gRPC. The adapter talks to the same
service's documented HTTP routes with `fetch` instead, which is what keeps this
plugin's dependency list at zod.

The seam is also worth keeping independently of the entry count. No official
iMessage API exists; every vendor that sells lines runs a macOS fleet under an
arrangement Apple tolerates rather than licenses, and at least one competitor has
been permanently banned mid-product. A vendor getting cut off should be an
adapter swap, not a rewrite.

Adding a provider means adding a directory under `src/providers/` and a
registry entry in `src/providers/index.ts`. Nothing above the seam changes. If
a change outside `src/providers/` needs to know which provider is active,
that is the signal the seam is in the wrong place — fix the seam.

The settings app (`apps/imessage-settings/`) POSTs to `routes/provider.ts` to
switch the channel, and to `routes/credentials.ts` to fill in what the selected
provider needs. Both paths and plugin boot go through `startChannelRuntime` in
`src/channel-runtime.ts` — deliberately, so the two cannot drift and show up as
"it works after a restart". Saving credentials for the *configured* provider
restarts ingress too: a channel idle for want of a key should come up when the
key arrives, not when someone remembers to click the provider again.

Re-posting the active provider still bounces its ingress, which is a useful
recovery for a wedged poll worker, but the app no longer does it on a click.
Clicking the provider you are already on now just keeps it selected. It used to
switch-and-restart, which is how someone clicking their own configured provider
got told the channel was idle.

`startChannelRuntime` never throws; it reports a `status`:

- **`running`** — ingress is up.
- **`idle`** — the provider was built here and could not come up. `idleReason`
  says why and the user can act on it.
- **`not-loaded`** — this process has no plugin runtime to restart. The config
  write still happened and applies on the next load.

That third case used to report itself as idle with the reason "plugin is not
initialized", which reads as a breakage to someone who just clicked a button.
Keep the distinction: an alarming banner for a state nobody caused and nobody
can fix is worse than no banner.

`startChannelRuntime` also clears the previous provider *before* building the
new one, so a failed switch cannot leave the old provider sending under a config
that no longer names it. With both shipping providers buildable, the tests reach
that path the way a real deployment would — a config naming a provider the
registry does not have, which is what an install carrying an older `provider`
value hands over after an upgrade.

## Outbound

Two callers, one set of rules.

- **The `imessage` skill** (`skills/imessage/`) is how the assistant sends
  deliberately. `scripts/send.ts` runs as a standalone bun process, so it
  resolves the API key via `assistant credentials reveal` rather than the
  in-process credential API. **It speaks Comms only.** The provider seam lives
  in-process and a standalone script cannot reach it, so rather than sending
  over a line the user did not configure, it reads `provider` out of
  `config.json` and refuses when that is not `comms`. Teaching it a second
  provider means giving the adapters a credential source that works outside the
  daemon — worth doing, and not a one-line change.
- **The channel transport** (`src/channel/transport.ts`) is how a reply goes
  back out once the host's inbound pipeline exists.

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

**Open question on Photon inbound.** Photon signs each delivery with
`X-Spectrum-Signature` (HMAC-SHA256 over the body, using a per-webhook secret
returned exactly once at registration) plus `X-Spectrum-Timestamp`, and
deduplicates on `webhookId + message.id`. Whether the gateway's verification
covers that scheme has not been confirmed against a running host. If it does
not, the rule above still stands — the fix belongs in the gateway, not in a
second verifier here — and poll ingress works in the meantime. Do not add
plugin-side signature checking to work around it without settling that first.

Polling exists for deployments whose gateway is not reachable from the
internet. It runs in **its own worker process** (`src/worker/`), not the
daemon: a busy line or a slow provider must not compete with the assistant's
event loop, and a crash in the loop must not take the daemon down. The
supervisor restarts it with backoff. Both providers support it.

## Credentials

Every secret lives in the credential store under the `imessage` service, never
in `config.json`. Which fields a provider needs is declared once, in
`PROVIDER_CREDENTIALS` in `src/config.ts`: `comms` takes `api_key`, `photon`
takes `photon_project_id` and `photon_project_secret`. The settings app renders
that list, and each adapter's `checkReadiness` resolves exactly those, so a
provider cannot ask for a credential the app never offers to collect.

**The settings app can write them.** `@vellumai/plugin-api` exports
`resolveCredential` and nothing that stores one, so `src/app-credentials.ts`
shells out to `assistant credentials set` — the same CLI the `imessage` skill's
script already uses for `reveal`. `execFile`, never `exec`, so no shell parses a
secret. The value does ride in argv for the moment the command runs; that is the
tradeoff the host's own documented command already makes, and writing the secret
into `config.json` instead would be worse and permanent.

**Values only ever travel inward.** The app is told whether a field is set,
never what it is set to. There is deliberately no GET on the credentials route:
a route that returns a stored secret would exist only to be called by something
that is not this app.

`checkReadiness` is not "are the credentials present". Photon's resolves both
fields *and* makes a control-plane call, because stopping at presence reports
ready for a mistyped project id, and the first symptom of that is a silently
dead line.

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

## Photon API facts worth not re-deriving

Control plane `https://spectrum.photon.codes`, `Authorization: Basic
base64(projectId:projectSecret)`. Every response is enveloped as
`{ succeed: true, data }` or `{ succeed: false, message }` — **a failure can
arrive inside a 200**, so the envelope is checked, not just the status.

- `GET /projects/{projectId}/` — the cheapest proof the credential pair works.
- `GET /projects/{projectId}/imessage/` — `{ type: "shared" | "dedicated" }`.
- `POST /projects/{projectId}/imessage/tokens` — mints message-plane tokens.
  Shared returns `{ token, expiresIn }`; dedicated returns `{ auth: {instanceId:
  token}, numbers: {instanceId: phone}, expiresIn }`, and the instance id then
  rides every message-plane call as `x-photon-server`.
- `POST /projects/{projectId}/webhooks/` — `{ webhookUrl }`. The `signingSecret`
  comes back **once** and is never retrievable; a lost one means delete and
  re-register.

Message plane `https://imessage.spectrum.photon.codes`, `Authorization: Bearer
<minted token>`, `x-idempotency-key` on mutations.

- `POST /v1/messages:sendText` — `{ chatGuid, text, clientMessageId }`.
- `POST /v1/chats` — `{ addresses, service: 1, clientMessageId, initialMessage? }`
  where `service: 1` is `CHAT_SERVICE_TYPE_IMESSAGE`. Creates or resolves the
  chat for those participants.
- `GET /v1/messages:listRecent` — `pageSize` (1–100), `after`, `before`,
  `isFromMe`, `pageToken`.

There is **no message send or list endpoint on the control plane**. Anything
that looks like one there is project management; sending lives on the message
plane and needs a minted token.

The message-plane payloads are protobuf-JSON, and their field names come from
the vendor SDK's own request mapping rather than a published wire contract.
Everything past `guid` and `isFromMe` is marked `UNVERIFIED` in
`src/providers/photon/schemas.ts` and is optional, so a wrong guess degrades
rather than drops a message. The webhook payload *is* documented and is pinned
to those names.

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
- **An app calls `window.vellum.fetch`, never the global `fetch`.** Apps under
  `apps/` are served in a sandboxed iframe whose origin is not the assistant's,
  so a bare `fetch` to a plugin route is cross-origin, carries no session, and
  fails as an opaque "Failed to fetch" — no status, no body, nothing naming the
  cause. The host injects the bridge; `@vellumai/plugin-api/app` types it
  (type-only, because an app cannot rely on runtime imports in the sandbox).
  `src/__tests__/app-bridge.test.ts` enforces it, because the failure only
  reproduces inside the sandbox — a same-origin dev server does not see it.
- **Request failures in an app are described from the response.** Status line,
  then the route's own `{ error, detail }` where there is one, then the raw
  body: a request can also fail ahead of the route, at the host proxy or the
  gateway, and those do not answer in the plugin's shape. Both this and the
  bridge call live in `apps/imessage-settings/src/api.ts`, apart from the
  rendering, so they are testable — `src/__tests__/app-api.test.ts` runs them
  under Bun. That is also why the bridge is read off `globalThis` rather than
  `window`: no DOM lib in this tsconfig, and no `window` under Bun.
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
