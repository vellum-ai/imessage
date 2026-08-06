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
message people it knows, and the recipient is not one of them yet. The plugin
registers a recipient automatically on the first send to a new number, so
seeing this means the registration itself failed. On a shared project the usual
cause is the project's shared-user cap; Photon's own message says which. There
is nothing to fix on the plugin side.

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

**Messages sent before setup do not appear** — expected. The channel starts from
the moment of setup rather than replaying history.

**Send reports success but nothing arrives** — Comms accepted it and delivery
failed downstream. Check the line's dashboard; the plugin only sees the API
response, not the carrier outcome.
