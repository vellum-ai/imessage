# Testing outbound

How to send a real message before inbound exists.

## What works today

**Outbound on the `comms` provider works end to end.** It needs no platform
support: the plugin holds a Comms API key and calls the documented Messages
API directly.

**Outbound on the `vellum` provider does not.** It needs two platform
endpoints that do not exist yet and a `platformFetch` the host does not inject,
so the channel comes up idle. Since `vellum` is the default, a fresh install
will report idle until you switch providers.

**Inbound does not reach the assistant on any provider.** Messages are polled
or received, validated, and normalized, but the host has no channel-provider
contract to hand them to yet. Test outbound now; inbound needs the host work.

## Setup

Mint a Comms key at https://comms.osis.co with the `comms_send` scope.
`comms_read` is only needed for poll ingress, which outbound testing does not
use.

```bash
assistant credentials set --service imessage --field api_key <key>
```

Switch the plugin to that provider:

```bash
curl -s -X POST "$INTERNAL_GATEWAY_BASE_URL/x/plugins/imessage/provider" \
  -H 'content-type: application/json' \
  -d '{"provider":"comms"}'
```

The response echoes the config and an `idleReason`. `"idleReason": null` means
the channel is running. Anything else is the reason it is not, and no send will
work until it clears.

## Send

Two paths, both through the same transport.

**Direct, no agent loop.** Isolates "does the provider send" from "does the
assistant decide to send":

```bash
curl -s -X POST "$INTERNAL_GATEWAY_BASE_URL/x/plugins/imessage/send" \
  -H 'content-type: application/json' \
  -d '{"to":"+15551234567","body":"hello from the assistant"}'
```

200 with an `externalMessageId` means Comms accepted it. 422 carries the
reason.

**Through the assistant.** Ask it to text you. The `send_imessage` tool is
`RiskLevel.High`, so expect an approval prompt — that is deliberate for
something that sends a real message to a real phone.

## What a send exercises

Both paths go through the channel transport, not the provider directly, so a
successful send also confirms:

- markdown flattening (send `**bold**` and check the bubble shows `bold`)
- handle normalization (send to `(555) 123-4567` and check it arrives)
- idempotency-key derivation (send the same text twice in quick succession;
  Comms collapses the second)

Worth doing all three on the first pass. They are the parts most likely to be
wrong in a way that only shows up on a real device.

## When it fails

**`"Comms API key not found"`** — the credential is missing or under the wrong
service name. `assistant credentials list`.

**403 from Comms** — the key lacks `comms_send`. Scopes are fixed at creation,
so mint a new key.

**`idleReason` mentions a platform caller** — the provider is still `vellum`.
The POST above did not take effect, or the config was overwritten.

**Send reports success but nothing arrives** — Comms accepted it and delivery
failed downstream. Check the line's dashboard; the plugin only sees the API
response, not the carrier outcome.
