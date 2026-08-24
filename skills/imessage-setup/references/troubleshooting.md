# iMessage setup troubleshooting

Symptoms and what actually causes them. Read the entry that matches rather than
working down the list — these are unrelated failures, not steps.

**"The Photon project ID is not set"** (or the Comms equivalent) — device
login (`connect.ts --finish`) did not complete, or the Comms key was never
stored. Check with `assistant credentials list`, or open the settings app,
which shows which fields are stored.

**Photon device login: "invalid_client"** — hosted Photon only accepts
registered device clients. The script uses Photon's published CLI client id
(`photon-cli`). Retry `--start`. If it still fails, use the manual
project-id / project-secret fallback in the settings app.

**Photon device login timed out or access_denied** — they did not approve in
time, or they clicked Deny. Run `--start` again and have them approve while
`--finish` is waiting.

**Photon: "invalid credentials"** — the project ID and secret are a pair; a
stale secret against a current id fails the same way a wrong id does. Re-copy
both from the dashboard rather than guessing which one drifted.

**Photon: "Target not allowed for this project"** — a Photon project may only
message people it knows, and the recipient is not one of them yet. This is a
project recipient-policy restriction, not a plugin or credential problem. No
message was sent.

Allow the number, then retry the send:

```bash
bun skills/imessage-setup/scripts/allow.ts --to "+15551234567"
```

Webhook registration also allows every phone number already on the assistant's
contacts. If the setup check is to a number that is not a contact, or the
contacts list was empty at start, that automatic pass will not have included
it — `--to` is the fix. `--contacts` re-runs the same pass by hand.

The plugin retries `POST /users/` only after a cold send is refused with this
error, then retries the send. Seeing this after a successful `allow.ts` means
the registration itself failed, or the plane refused for another reason. On a
shared project the usual cause is the project's shared-user cap; Photon's own
message says which.

**403 from Comms on send** — the key lacks `comms_send`. Mint a new one; scopes
cannot be added.

**Sends work, nothing arrives** — in webhook mode, check the gateway's version
before anything else: it has to read the verification descriptors in
`channels/ingress.json`, and a gateway that predates them refuses every
delivery with a 403 before the plugin sees it. Linq's route is
`standard-webhooks`; a gateway that only knows `hmac` 403s every Linq
delivery. Switching to live (Photon) or poll sidesteps the question
entirely. In poll mode, check that the key carries `comms_read` (Comms)
or that the Linq token can list chats. In live mode, check the plugin
log for `live stream failed` or `waiting until the provider is ready`.

**`{"error":"Not Found"}` on every delivery** — that body is the gateway's, and
it means the gateway found no servable route at that path. It says nothing more
on purpose: the path is reachable by anyone on the internet, so a route held
back by approval is answered identically to one nobody declared. Two causes
produce it, and the listing tells them apart. From the assistant host:

```
curl -s localhost:7830/v1/channel-ingress
```

*The declaration is `pending`.* Both routes verify against a secret this plugin
holds rather than the platform's, so neither is served until a guardian
approves:

```
curl -s -X POST localhost:7830/v1/channel-ingress/imessage/approve \
  -H 'content-type: application/json' -d '{"digest":"<digest>"}'
```

The digest covers what the declaration asks for, so editing `ingress.json` —
adding a route, changing what verifies one — drops it back to pending and needs
a fresh approval. An approved route whose credential is not set answers 409
rather than 404; the listing names the credential each route reads.

*The declaration is `approved` and deliveries still 404.* Check the path that
actually arrived. Vellum's managed callback layer 301s a slashless POST onto
the trailing-slash spelling, and following that redirect drops the body — the
trailing-slash URL then 404s before HMAC. This plugin registers the
trailing-slash URL with Photon so the vendor never walks that redirect. If an
older registration is still slashless, restart the channel (or re-save
credentials) so `ensureWebhook` can replace it.

**Checking inbound without waiting for a text.** On Comms, `POST
/api/v1/comms/webhooks/{id}/test` sends a signed `comms.ping` through the real
delivery pipeline (same envelope, same signature). The plugin registers for
that event alongside `comms.message.received`; a webhook subscribed only to
received leaves the ping pending with zero attempts. Restart the channel (or
re-save credentials) so `ensureWebhook` can replace a received-only
registration. A 403 at the gateway means verification is not implemented for
the route's descriptor yet; a 200 with `probe: "comms.ping"` in the plugin's
reply means the whole path works and a ping is simply not a turn.

**The provider shows zero webhooks and nothing says why** — the plugin records
its last registration attempt in the settings app, and the line names the step
it stopped at (`read-secret`, `resolve-url`, `call-provider`, `store-secret`).
Four unrelated things fail here and the remedies have nothing in common, so
read the step before changing anything:

- `read-secret` — never fatal on its own; registration continues. If it
  appears, the credential store answered oddly.
- `resolve-url` — there is no address to register. The assistant needs a
  tunnel or a public ingress URL, or `ingressMode: "live"` (Photon) or
  `"poll"`.
- `call-provider` — the provider refused. The reason carries its status and
  its own words: a 401 is the wrong key, a 403 is a missing scope
  (`comms_webhooks`), a `could not be reached` is the network.
- `store-secret` — the registration exists but its secret was not saved, so
  deliveries will not verify. Re-run setup.

**"could not be read"** — the store's own words follow. The host raises one
error for a missing credential, an unreachable credential store, and a
scoping refusal, so the plugin cannot tell them apart and does not pretend
to. Read that reported cause before re-entering a credential. A restart is
the usual context: the store may simply not have been up yet, in which case
the value was fine and the next start will find it.

**Messages sent before setup do not appear** — expected. The channel starts from
the moment of setup rather than replaying history.

**Send reports success but nothing arrives** — Comms accepted it and delivery
failed downstream. Check the line's dashboard; the plugin only sees the API
response, not the carrier outcome.
