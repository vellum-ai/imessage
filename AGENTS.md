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

- **`photon`** (default) — the user's own Photon (Spectrum) project. Two hosts
  and **two protocols**: a **control plane** at `spectrum.photon.codes`, plain
  REST with `Basic base64(projectId:projectSecret)`, and a **message plane** at
  `imessage.spectrum.photon.codes`, **gRPC only**, bearer-authenticated with a
  short-lived token minted from the control plane. Every send is therefore
  mint-then-call; the token is cached until shortly before it expires, and the
  SDK resolves it per RPC so a rotation costs a mint rather than a reconnect.
  `src/providers/photon/client.ts` speaks the control plane directly;
  `message-client.ts` is the only file that imports the vendor SDK. Nothing
  above the seam knows there are two hosts.
- **`comms`** — the user's own Comms by Osis workspace, API key, and line. One
  REST API, one credential, both directions.

Photon addresses a conversation by **chat guid** (`any;-;+15551234567`), not by
phone number. A reply already has one — the webhook's `space.id` is exactly
that guid — so only a cold send to a bare handle resolves a chat first, and
that resolution carries the message with it rather than paying two round trips.

**The message plane does not serve REST, and there is no hosted HTTP option.**
That host is Envoy in front of a gRPC service: it answers 415 with an empty
body to anything that is not gRPC, including a bodiless `GET /`. An earlier
version of this adapter spoke HTTP to it and every send failed with a bare
`415` and no explanation, because there was no response body to explain
anything.

The REST routes are real — `POST /v1/chats`, `POST /v1/messages:sendText` —
but they belong to `imessage-server-v2-http`, which Photon publishes as
software you deploy rather than as a service it hosts. Its own SDK examples
address it as `localhost:8080` or an env var. Reaching Photon's hosted plane
means gRPC, which is why `@photon-ai/advanced-imessage` is a dependency.

Keep it confined to `message-client.ts`. It pulls in `@grpc/grpc-js` and a
protobuf runtime, and one import site is what keeps the rest of the plugin
loadable — and testable — without any of that. That module also takes a
factory, so no test opens a real channel.

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

**The app follows the assistant's own BYO-service forms** —
`clients/web/src/components/speech/stt-provider-form.tsx` in vellum-assistant.
Same shape: title and subtitle, a provider dropdown, that provider's key
fields, a credentials callout linking to where the key comes from, and a
right-aligned Save that only lights up when something changed. It cannot import
that design library (the app is sandboxed, with no access to the host
stylesheet or its CSS custom properties), so the structure is reproduced
against system colors. Match that file when changing this app, not the other
way round.

Picking a provider is a **draft until Save**, which is what the reference form
does and what keeps a click on the provider you already use from restarting
your channel. Save writes the provider first and the credentials second: the
switch restarts ingress on a provider whose key may be missing, and storing the
key restarts it again — that second pass is the one that comes up. Re-posting
the active provider bounces ingress for anyone calling the route directly,
which stays a useful recovery for a wedged poll worker.

One deliberate divergence: the reference's Reset deletes a stored key. The
plugin API can only *set* a credential, never remove one, so Reset here reverts
the form to what is saved rather than pretending to clear the store.

**Display copy lives in the app, field identity on the server.** The routes
report `{ field, label, placeholder, secret, set }` — enough to draw an input —
and the app's `PROVIDER_CATALOG` holds the prose: display name, subtitle, and
where to get the credential. Same split the reference makes.

`startChannelRuntime` never throws; it reports a `status`:

- **`running`** — ingress is up.
- **`idle`** — the provider was built here and could not come up. `idleReason`
  says why and the user can act on it.

There is deliberately no third state for "this caller has no runtime". A save
arriving before `init` used to report one, saying the write applied on the next
reload — true, and read as an alarm about a channel nobody had broken.
`derivedContext` removes the condition: everything `init` stashes is derivable
from `plugin-paths.ts`, and for an external plugin the storage directory it
derives is the same `<plugin>/data` the host passes in, so a channel built on
it writes the same poll cursor.

`startChannelRuntime` also clears the previous provider *before* building the
new one, so a failed switch cannot leave the old provider sending under a config
that no longer names it.

## Outbound

Two callers, one set of rules.

- **The `imessage` skill** (`skills/imessage/`) is how the assistant sends
  deliberately. `scripts/send.ts` runs as a standalone bun process and **uses
  the same adapters** — it calls `resolveProvider` and hands the result a
  chunked body, exactly as the transport does. There is no provider-specific
  code in the skill, so a new provider is never something anyone has to teach
  it.

  That works because `@vellumai/plugin-api` resolves to the **workspace shim**
  the daemon materializes (`ensurePluginApiShim`), which prefers the namespace a
  host parked on `globalThis` and falls back to importing the plugin-api source
  directly when no host did — credentials being one of the surfaces that
  fallback exists for. The installer also strips the `@vellumai/plugin-api`
  peer for the duration of `bun install` so a registry copy cannot shadow that
  shim. Both halves matter: without the strip, a plugin-local copy of the
  published package resolves first, and the published package has no fallback,
  so every export is `undefined` in a subprocess.
- **The channel transport** (`src/channel/transport.ts`) is how a reply goes
  back out once the host's inbound pipeline exists.

Both go through `src/channel/render.ts` for chunking and idempotency keys, and
both normalize a recipient through `src/channel/identity.ts`: a skill send and
a channel reply have to format identically and address the same person the same
way, and two copies of either rule would drift.

**Long replies are chunked, never truncated.** An earlier version cut at the
limit and appended an ellipsis, which silently dropped the end of every long
answer. Each chunk carries its own idempotency key including its **index** — a
long reply can legitimately repeat itself, and keying on the body alone had the
provider collapse the duplicate chunk and drop it.

## Ingress

Webhooks are the default, and registering them is **this plugin's job**. The
gateway serves the route but never holds a provider credential, so nothing else
in the system is in a position to tell Comms or Photon where to deliver.
`ensureWebhook` on the provider seam does it: list first, create only when
nothing matches, run on every webhook-mode start. That is what makes saving a
credential in the settings app finish setup — the restart that follows the save
is what registers.

### One route per provider

`channels/ingress.json` declares `events-photon` and `events-comms`, each with
its own handler file under `routes/`. The provider is part of the path, not a
config lookup, and that is the whole point: **which provider signed a delivery
decides how it must be verified, and the gateway reads only its own static
manifest.** Putting the provider in the URL lets a static declaration describe
a plugin whose provider is a runtime choice. It also means a delivery is always
read by the adapter that understands its payload — a Comms envelope handed to
the Photon normalizer parses as nothing at all.

A delivery arriving for a provider that is not currently configured is a stale
registration. It answers 200 and ignores the message: the delivery is authentic
and retrying will not change the answer, while a 4xx would make the provider
retry or disable a webhook whose only problem is that it is out of date.

### Verification is declared, not implemented here

Each route carries a `verification` descriptor saying how the gateway should
check a delivery — algorithm, which credential field holds the secret, where
the signature is, and exactly which bytes it covers. The manifest is the spec:
it is declarative on purpose, so a third vendor is a manifest edit rather than
gateway code.

Both providers sign, and they sign differently — which is the whole reason the
descriptor is data rather than a scheme name:

- **Photon** signs `HMAC-SHA256(secret, "v0:" + timestamp + ":" + rawBody)` and
  sends it as `X-Spectrum-Signature: v0=<hex>`, with `X-Spectrum-Timestamp` and
  a five-minute tolerance. Its secret is issued **once**, from
  `POST /projects/{id}/webhooks/`, and never appears in a listing — so
  registration stores it immediately, and a registration whose secret was lost
  is deleted and recreated rather than reused. A webhook nothing can verify is
  worse than no webhook.
- **Comms** signs `HMAC-SHA256(secret, rawBody)` — the body alone — and sends it
  as `X-Osis-Signature: sha256=<hex>`, alongside `X-Osis-Event`. Its `whsec_`
  secret comes back from the create **and** from `GET /webhooks`, so a lost one
  is re-readable and an existing registration is never torn down to recover it.

**Comms has no replay window.** Nothing in its signature binds a timestamp, so a
captured delivery stays valid indefinitely; Photon's five-minute tolerance is
the reason its descriptor carries `freshness` and Comms' does not. Deduplicating
on message id is what bounds the damage, and that belongs to the host's inbound
pipeline rather than here.

Both are HMAC over raw bytes, so **the gateway must hash the body it received**,
before any parse. A re-serialized JSON body does not match, and the failure
looks like a wrong secret.

Both secrets live in the credential store under `WEBHOOK_SECRET_FIELDS`
(`src/config.ts`), never in `PROVIDER_CREDENTIALS` — nobody types them, and the
settings app must not offer a field for a value the user cannot know.

**`channels/ingress.json` is read by the gateway and by nothing in this
plugin's type system.** Every fact stated in both places can drift silently,
and the symptom is deliveries failing verification with both sides looking
correct. `src/__tests__/ingress-manifest.test.ts` is the join: it holds the
manifest against `PROVIDER_IDS`, `WEBHOOK_SECRET_FIELDS`,
`WEBHOOK_VERIFICATION`, the route paths the plugin registers, and the handler
files on disk.

**Until the gateway implements the descriptor, deliveries are still refused** —
it verifies `Vellum-Signature` against `<plugin>/webhook_secret` and neither
vendor can produce that. The manifest is forward-compatible either way: the
current route schema is a non-strict `z.object`, so an unknown `verification`
key is dropped rather than rejected. **Poll ingress is the one that works end
to end** in the meantime; both providers support it. It runs in **its own
worker process** (`src/worker/`), not the daemon: a busy line or a slow
provider must not compete with the assistant's event loop, and a crash in the
loop must not take the daemon down. The supervisor restarts it with backoff.

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

## Where a provider is told to deliver

`resolveWebhookEndpoint` asks the **host** for the URL, via
`resolvePluginWebhookUrl` in `@vellumai/plugin-api`. Do not compose one from
`ingress.publicBaseUrl`, which is what this plugin used to do: on a
platform-connected assistant that value holds the **Velay tunnel URL**, so the
vendor webhook registered cleanly and every delivery went somewhere the gateway
was not serving. The correct order is platform pods first, then a configured
public ingress, then a managed callback route — the same order `webhooks
register` uses, which is exactly why it belongs to the host rather than to a
copy here.

The config fallback is still in the file for a host that predates that export.
It carries the old flaw, so treat it as a compatibility shim, not a second
supported path.

## Photon API facts worth not re-deriving

Control plane `https://spectrum.photon.codes`, `Authorization: Basic
base64(projectId:projectSecret)`. Every response is enveloped as
`{ succeed: true, data }` or `{ succeed: false, message }` — **a failure can
arrive inside a 200**, so the envelope is checked, not just the status.

- `GET /projects/{projectId}/` — the cheapest proof the credential pair works.
- `GET /projects/{projectId}/imessage/` — `{ type: "shared" | "dedicated" }`.
- `POST /projects/{projectId}/imessage/tokens` — mints message-plane tokens.
  Shared returns `{ token, expiresIn }`; dedicated returns `{ auth: {instanceId:
  token}, numbers: {instanceId: phone}, expiresIn }`.
- `POST /projects/{projectId}/webhooks/` — `{ webhookUrl }`. The `signingSecret`
  comes back **once** and is never retrievable; a lost one means delete and
  re-register.
- `POST /projects/{projectId}/users/` — **a project may only message people it
  knows.** Anyone else is refused at the message plane with "Target not allowed
  for this project", which is a policy answer that reads exactly like a bad
  address. `{ type: "shared", phoneNumber }` lets the server allocate a line
  out of its pool (capped by `maxSharedUsers`); `{ type: "dedicated",
  phoneNumber, assignedPhoneNumber }` names a line the project owns, which the
  token mint already reports in `numbers`. Idempotent — shared users key on
  `phoneNumber`, dedicated on the `(phoneNumber, assignedPhoneNumber)` tuple —
  so calling it on a cold send is safe. `GET /users/` lists (with `search`,
  `type`, pagination), `DELETE /users/{userId}/` soft-deletes.

Photon's word for a permitted recipient is a **user**, not an allowlist entry,
and the distinction is load bearing: a shared project allocates each user their
own `assignedPhoneNumber`, so registering one is provisioning rather than
flipping a permission. That is also the concrete reason a shared line cannot
promise anyone a stable number.

Message plane `imessage.spectrum.photon.codes:443`, **gRPC**, bearer metadata
carrying the minted token. Reached through the SDK, not by hand:

- `messages.sendText(chatGuid, text, { clientMessageId })`
- `chats.create(addresses, { clientMessageId, message? })` — creates or
  resolves the chat for those participants.
- `messages.listRecent({ pageSize (1–100), after, before, isFromMe, pageToken })`

Dedicated projects mint one token per instance. The HTTP middleware routes
those with `x-photon-server`; the gRPC client has no such option, so the
per-instance token is what identifies the instance. Untested against a real
dedicated project.

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
