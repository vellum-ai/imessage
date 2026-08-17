# iMessage setup troubleshooting

Symptoms and what actually causes them. Read the entry that matches rather than
working down the list — these are unrelated failures, not steps.

**"The Photon project ID is not set"** (or the Comms equivalent) — step 2 was
skipped or used a different service name. Check with `assistant credentials
list`, or open the settings app, which shows which fields are stored.

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

The plugin still registers a recipient on the first send to a new number, so
seeing this after a successful `allow.ts` means the registration itself failed.
On a shared project the usual cause is the project's shared-user cap; Photon's
own message says which.

**403 from Comms on send** — the key lacks `comms_send`. Mint a new one; scopes
cannot be added.

**Sends work, nothing arrives** — in webhook mode, check the gateway's version
before anything else: it has to read the verification descriptors in
`channels/ingress.json`, and a gateway that predates them refuses every
delivery with a 403 before the plugin sees it. Switching to poll sidesteps the
question entirely. In poll mode, check that the key carries `comms_read`.

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
actually arrived. The platform's callback layer redirects a slashless request
to a trailing-slash URL, and a gateway that predates that tolerance matches the
requested spelling against the declared `events-comms` exactly. Nothing on this
side can avoid it — the slash is re-added downstream of whatever the plugin
registered — so the fix is a gateway new enough to ignore it.

**Checking inbound without waiting for a text** — on Comms, `POST
/api/v1/comms/webhooks/{id}/test` sends a signed `comms.ping` through the real
delivery pipeline (same envelope, same signature). A 403 at the gateway means
verification is not implemented for the route's descriptor yet; a 200 with
`ignored: "not an inbound message"` in the plugin's logs means the whole path
works and a ping is simply not a turn.

**The provider shows zero webhooks and nothing says why** — the plugin records
its last registration attempt in the settings app, and the line names the step
it stopped at. Four unrelated things fail here and the remedies have nothing in
common, so read the step before changing anything:

- *reading the stored webhook secret* — never fatal on its own; registration
  continues. If it appears, the credential store answered oddly.
- *working out this assistant's public URL* — there is no address to register.
  The assistant needs a tunnel or a public ingress URL, or `ingressMode: "poll"`.
- *asking the provider to register the webhook* — the provider refused. The
  reason carries its status and its own words: a 401 is the wrong key, a 403 is
  a missing scope (`comms_webhooks`), a `could not be reached` is the network.
- *storing the secret the provider issued* — the registration exists but its
  secret was not saved, so deliveries will not verify. Re-run setup.

**"could not be resolved — most likely it is not set"** — the wording is hedged
because it has to be. The host raises one error for a missing credential, an
unreachable credential store, and a scoping refusal, so the plugin cannot tell
them apart and does not pretend to. The sentence ends with what the store
itself said; read that before re-entering a credential. A restart is the usual
context — the store may simply not have been up yet, in which case the value
was fine and the next start will find it.

**Messages sent before setup do not appear** — expected. The channel starts from
the moment of setup rather than replaying history.

**Send reports success but nothing arrives** — Comms accepted it and delivery
failed downstream. Check the line's dashboard; the plugin only sees the API
response, not the carrier outcome.
