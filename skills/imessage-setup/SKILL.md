---
name: imessage-setup
description: Set up the iMessage channel with a Comms by Osis account so the assistant can send and receive texts. Use when the user wants to text the assistant, when a send fails with a missing credential or 401, or when the channel reports it is idle.
metadata:
  emoji: "💬"
  vellum:
    category: "messaging"
    display-name: "iMessage Setup"
---

Connects the iMessage channel to the user's own [Comms by
Osis](https://comms.osis.co) account.

## Set expectations first

Say this before starting, because it is usually not what people picture:

- The user creates their **own** Comms account and their own line. Vellum does
  not provide a number, and there is no bundled option.
- People reach the assistant by texting **that line**, not the user's own
  number.
- The assistant does **not** read the user's personal iMessage account or
  history.

If the user wanted the assistant to read and answer their existing personal
iMessage threads, this is the wrong tool. Say so plainly rather than proceeding.

Worth mentioning if they ask why they have to bring their own: dedicated
iMessage lines run about $250/month from the vendors that offer them, and a
shared line cannot give anyone a stable number. Bring-your-own is the only
honest shape for now.

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

## 2. Store the key

```bash
assistant credentials set --service imessage --field api_key <key>
```

Never put the key in `config.json` and never paste it into chat. The plugin
reads it from the credential store at call time, so rotating it later needs no
restart.

## 3. Confirm sending works

```bash
bun skills/imessage/scripts/send.ts --to "<the user's own number>" --body "Setup check from your assistant."
```

Have the user confirm it arrived. Sending is the half that needs only
`comms_send`, so this isolates a credential problem from an ingress problem.

## 4. Inbound

Inbound is webhook-first. Register the endpoint with Comms pointing at:

```
<public ingress URL>/webhooks/plugins/imessage/events
```

Get the base with `assistant config get ingress.publicBaseUrl` — never hardcode
a host. The gateway verifies the delivery signature before the plugin sees it,
so there is nothing to configure plugin-side for that. A guardian must approve
the plugin's ingress declaration before the gateway serves the route.

If the deployment's gateway is not reachable from the internet (self-hosted
behind NAT), switch to polling in the plugin's `config.json`:

```json
{ "ingressMode": "poll", "pollIntervalMs": 5000 }
```

Polling needs `comms_read`, runs in its own worker process, and starts from the
moment it is enabled rather than replaying the line's history. It costs latency
and burns requests while the line is quiet, so prefer webhooks where the
deployment allows them.

## Configuration

Optional, in the plugin's `config.json`:

| Key | Default | Meaning |
| --- | --- | --- |
| `ingressMode` | `"webhook"` | `"webhook"` or `"poll"`. |
| `pollIntervalMs` | `5000` | Delay between polls, 2000 to 300000. Poll mode only. |
| `sendChannel` | unset | Force `"sms"` or `"imessage"`. Leave unset. |
| `allowedHandles` | `[]` | E.164 handles allowed through. Empty allows all. |

`allowedHandles` is a coarse pre-filter, not a security control — the
assistant's admission policy is the real gate and applies either way.

## Troubleshooting

**"No Comms API key found"** — step 2 was skipped or used a different service
name. Check with `assistant credentials list`.

**403 from Comms on send** — the key lacks `comms_send`. Mint a new one; scopes
cannot be added.

**Sends work, nothing arrives** — in webhook mode the endpoint is not
registered, the registered URL no longer matches `ingress.publicBaseUrl` (a
changed tunnel URL is the usual cause), or the guardian has not approved the
ingress declaration. In poll mode the key lacks `comms_read`.

**Messages sent before setup do not appear** — expected. The channel starts from
the moment of setup rather than replaying history.

**Send reports success but nothing arrives** — Comms accepted it and delivery
failed downstream. Check the line's dashboard; the plugin only sees the API
response, not the carrier outcome.
