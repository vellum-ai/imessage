---
name: imessage-setup
description: Set up the iMessage channel with the user's own Comms by Osis or Photon account so the assistant can send and receive texts. Use when the user wants to text the assistant, when a send fails with a missing credential or 401, or when the channel reports it is idle.
metadata:
  emoji: "💬"
  vellum:
    category: "messaging"
    display-name: "iMessage Setup"
---

Connects the iMessage channel to the user's own line, from either [Comms by
Osis](https://comms.osis.co) or [Photon](https://photon.codes).

## Set expectations first

Say this before starting, because it is usually not what people picture:

- The user creates their **own** account with one of the two vendors, and their
  own line. There is no number provided for them.
- People reach the assistant by texting **that line**, not the user's own
  number.
- The assistant does **not** read the user's personal iMessage account or
  history.

If the user wanted the assistant to read and answer their existing personal
iMessage threads, this is the wrong tool. Say so plainly rather than proceeding.

Worth mentioning if they ask why they have to bring their own: dedicated
iMessage lines run about $250/month from the vendors that offer them, and a
shared line cannot give anyone a stable number. Bring-your-own is the only
honest shape for now. Do not promise a provided line is coming.

## Pick a provider

Either works. Ask which account they already have before creating one.

| | Comms by Osis | Photon |
| --- | --- | --- |
| Credentials | One API key | Project ID + project secret |
| Sending | One REST call | Mints a short-lived token, then sends |
| Ingress | Webhook or poll | Webhook or poll |

Everything below covers Comms. For Photon, the shape is the same and only the
two steps marked **Photon** differ.

## 1. Create the line and mint a key

Direct the user to https://comms.osis.co to create a workspace, provision a
line, and mint a Messages API key.

Scopes the key needs:

| Scope | Needed for |
| --- | --- |
| `comms_send` | Sending. Always required. |
| `comms_read` | Poll ingress only. |
| `comms_webhooks` | Registering the webhook endpoint. |

Have them mint all three up front. **Scopes are fixed at creation** — a key
missing one has to be replaced, not upgraded, so a second trip to the dashboard
is the common failure of doing this piecemeal.

**Photon** — instead of the above: have the user create a project at
https://photon.codes, then take its **project ID** and **project secret** from
the dashboard. Photon has no scope list to get wrong; the pair authenticates
everything, and the line comes from the project rather than being provisioned
separately.

## 2. Store the credentials

The settings app is the shortest path: open the iMessage plugin's settings,
pick the provider, and fill in its fields. It stores them in the credential
store and restarts the channel.

From a terminal instead:

```bash
# Comms
assistant credentials set --service imessage --field api_key <key>

# Photon
assistant credentials set --service imessage --field photon_project_id <id>
assistant credentials set --service imessage --field photon_project_secret <secret>
```

Never put a secret in `config.json` and never paste one into chat. The plugin
reads them from the credential store at call time, so rotating one later needs
no restart.

## 3. Confirm sending works

```bash
bun skills/imessage/scripts/send.ts --to "<the user's own number>" --body "Setup check from your assistant."
```

Have the user confirm it arrived. Sending is the half that needs only
`comms_send`, so this isolates a credential problem from an ingress problem.

**Photon** — this script speaks Comms only and will refuse rather than send
over the wrong line. Confirm a Photon setup from the settings app instead: it
reports the channel as running once the project ID and secret resolve.

## 4. Inbound

**Use polling.** It is the ingress that works end to end today:

```json
{ "ingressMode": "poll", "pollIntervalMs": 5000 }
```

Polling needs `comms_read` on Comms, runs in its own worker process, and starts
from the moment it is enabled rather than replaying the line's history. It
costs latency and burns requests while the line is quiet.

Webhooks would be preferable and the plugin already registers them — on every
webhook-mode start it points the provider at
`<ingress.publicBaseUrl>/webhooks/plugins/imessage/events`, which needs
`assistant config get ingress.publicBaseUrl` to be set and a guardian to have
approved the plugin's ingress declaration. **But the gateway refuses those
deliveries.** It verifies a `Vellum-Signature` HMAC computed with the plugin's
own `webhook_secret`, and neither Comms nor Photon can send that header, so
every delivery is a 403 before the plugin sees it. Do not spend a setup session
debugging that — it is a gateway-side gap, tracked in `AGENTS.md`.

## Configuration

Optional, in the plugin's `config.json`:

| Key | Default | Meaning |
| --- | --- | --- |
| `provider` | `"comms"` | `"comms"` or `"photon"`. Set it from the settings app, which restarts ingress; editing it here needs a reload. |
| `ingressMode` | `"webhook"` | `"webhook"` or `"poll"`. |
| `pollIntervalMs` | `5000` | Delay between polls, 2000 to 300000. Poll mode only. |
| `sendChannel` | unset | Force `"sms"` or `"imessage"`. Leave unset. |
| `allowedHandles` | `[]` | E.164 handles allowed through. Empty allows all. |

`allowedHandles` is a coarse pre-filter, not a security control — the
assistant's admission policy is the real gate and applies either way.

## Troubleshooting

**"The Comms API key is not set"** (or the Photon equivalent) — step 2 was
skipped or used a different service name. Check with `assistant credentials
list`, or open the settings app, which shows which fields are stored.

**Photon: "invalid credentials"** — the project ID and secret are a pair; a
stale secret against a current id fails the same way a wrong id does. Re-copy
both from the dashboard rather than guessing which one drifted.

**403 from Comms on send** — the key lacks `comms_send`. Mint a new one; scopes
cannot be added.

**Sends work, nothing arrives** — in webhook mode this is expected: the gateway
rejects provider deliveries (see step 4). Switch to poll. In poll mode, check
that the key carries `comms_read`.

**Messages sent before setup do not appear** — expected. The channel starts from
the moment of setup rather than replaying history.

**Send reports success but nothing arrives** — Comms accepted it and delivery
failed downstream. Check the line's dashboard; the plugin only sees the API
response, not the carrier outcome.
