---
name: imessage-setup
description: Set up the iMessage channel with the user's own Photon or Comms by Osis account so the assistant can send and receive texts. Use when the user wants to text the assistant, when a send fails with a missing credential or 401, or when the channel reports it is idle.
metadata:
  emoji: "💬"
  vellum:
    category: "messaging"
    display-name: "iMessage Setup"
---

Connects the iMessage channel to the user's own line, from either
[Photon](https://photon.codes) (the default) or [Comms by
Osis](https://comms.osis.co).

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

| | Photon (default) | Comms by Osis |
| --- | --- | --- |
| Credentials | Project ID + project secret | One API key |
| Sending | Mints a short-lived token, then sends over gRPC | One REST call |
| Ingress | Webhook, live gRPC, or poll | Webhook or poll |

Everything below covers Photon. For Comms, the shape is the same and only the
two steps marked **Comms** differ.

## 1. Create the line and get credentials

Direct the user to https://photon.codes to create a project, then take its
**project ID** and **project secret** from the dashboard. There is no scope list
to get wrong: the pair authenticates everything, and the line comes from the
project rather than being provisioned separately.

**Comms** — instead of the above: create a workspace at https://comms.osis.co,
provision a line, and mint a Messages API key. Scopes the key needs:

| Scope | Needed for |
| --- | --- |
| `comms_send` | Sending. Always required. |
| `comms_read` | Poll ingress only. |
| `comms_webhooks` | Registering the webhook endpoint. |

Have them mint all three up front. **Scopes are fixed at creation** — a key
missing one has to be replaced, not upgraded, so a second trip to the dashboard
is the common failure of doing this piecemeal.

## 2. Store the credentials

The settings app is the shortest path: open the iMessage plugin's settings,
pick the provider, and fill in its fields. It stores them in the credential
store and restarts the channel.

From a terminal instead:

```bash
# Photon
assistant credentials set --service imessage --field photon_project_id <id>
assistant credentials set --service imessage --field photon_project_secret <secret>

# Comms
assistant credentials set --service imessage --field api_key <key>
```

Never put a secret in `config.json` and never paste one into chat. The plugin
reads them from the credential store at call time, so rotating one later needs
no restart.

## 3. Allow the people Photon may message

Photon will only message numbers the project already knows. Anyone else is
refused with `Target not allowed for this project` — a policy answer that
reads like a bad address. The plugin registers a recipient on the first send,
but a setup check is that first send, so it fails unless the number is allowed
first.

Storing the credentials (step 2) restarts the channel, which registers the
webhook **and** allows every phone number already on the assistant's contacts.
If that list was empty, unreadable, or the number you want to text is not a
contact yet, allow it by hand:

```bash
# Every contact that already has a phone number
bun skills/imessage-setup/scripts/allow.ts --contacts

# One number — the user's own, a test recipient, someone not yet a contact
bun skills/imessage-setup/scripts/allow.ts --to "+15551234567"
```

`--to` accepts E.164 (`+15551234567`) or a US national number; anything else
is rejected rather than guessed at. Comms has no such restriction — skip this
step there.

## 4. Confirm sending works

```bash
bun skills/imessage/scripts/send.ts --to "<the user's own number>" --body "Setup check from your assistant."
```

Have the user confirm it arrived. The script sends through the same provider
adapter the channel uses, over whichever line `config.json` names, so this
isolates a credential problem from an ingress problem on either provider. If
Photon still answers `Target not allowed for this project`, the number was not
allowed — go back to step 3 rather than rotating credentials.

## 5. Inbound

**Use polling.** It is the ingress that works end to end today:

```json
{ "ingressMode": "poll", "pollIntervalMs": 5000 }
```

Polling needs `comms_read` on Comms, runs in its own worker process, and starts
from the moment it is enabled rather than replaying the line's history. It
costs latency and burns requests while the line is quiet.

Webhooks are preferable and the plugin registers them on every webhook-mode
start, pointing the provider at its own route,
`/webhooks/plugins/imessage/events-<provider>`. The public base comes from the
host — a managed platform callback route, or a configured public ingress — so
there is nothing to compose or configure here. On Photon, that same start also
allows the assistant's contact phone numbers (step 3); a number added as a
contact later still needs `allow.ts`.

Photon also has a live gRPC mode (`ingressMode: "live"`) that reads inbound
off the same message-plane connection send already uses. It needs no public
URL and no webhook secret. Pick it from the settings app when the assistant
has no reachable ingress. Comms has no such stream.

## Configuration

Optional, in the plugin's `config.json`:

| Key | Default | Meaning |
| --- | --- | --- |
| `provider` | `"photon"` | `"photon"` or `"comms"`. Set it from the settings app, which restarts ingress; editing it here needs a reload. |
| `ingressMode` | `"webhook"` | `"webhook"`, `"live"` (Photon gRPC stream), or `"poll"`. Set it from the settings app, which restarts ingress. |
| `pollIntervalMs` | `5000` | Delay between polls, 2000 to 300000. Poll mode only, and not surfaced in the settings app. |

## Troubleshooting

Read [`references/troubleshooting.md`](references/troubleshooting.md) when a
step fails. It covers each symptom the two providers produce — missing
credentials, Photon's `Target not allowed for this project`, Comms scope
errors, and sends that succeed while nothing arrives. The Photon allow script
is in this skill: `scripts/allow.ts`.
