---
name: imessage-setup
description: Set up the iMessage channel with the user's own Photon account so the assistant can send and receive texts. Use when the user wants to text the assistant, when a send fails with a missing credential or 401, or when the channel reports it is idle. Comms by Osis is coming soon; do not set it up.
metadata:
  emoji: "💬"
  vellum:
    category: "messaging"
    display-name: "iMessage Setup"
---

Connects the iMessage channel to the user's own [Photon](https://photon.codes)
line by default. [Linq](https://dashboard.linqapp.com/sandbox) is also
selectable from the settings app for a prototype. Comms by Osis is
implemented but not offered yet. Do not collect a Comms API key, do not set
`provider` to `comms`, and do not walk them through the Comms dashboard.

## Set expectations first

Say this before starting, because it is usually not what people picture:

- The user creates their **own** account with Photon or Linq, and their
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

Photon is the default and the path this skill walks. Linq is also
selectable in the settings app: they paste a V3 API token from
https://dashboard.linqapp.com/sandbox and switch the provider to Linq.
The settings app still lists Comms by Osis, disabled, with a "Coming soon"
tooltip. If they ask for Comms, say it is coming soon and continue with
Photon or Linq.

## 1. Create the line and get credentials

**Photon (preferred):** do not send the user to copy a project secret. Run the
device login so Photon creates or reuses a project named "Vellum Assistant"
and this plugin stores the id and secret itself.

```bash
bun skills/imessage-setup/scripts/connect.ts --start
```

Show the user the printed URL and the short code. They sign in at
https://app.photon.codes if needed, confirm the code matches, and click
Approve. Then:

```bash
bun skills/imessage-setup/scripts/connect.ts --finish
```

`--finish` waits until they approve, then writes `photon_project_id` and
`photon_project_secret` to the credential store. It never prints the secret.
If they already have a "Vellum Assistant" project, it reuses it and rotates
that project's secret. Pass `--force` on both commands only when they asked
to reconnect.

If device login is unavailable, the manual fallback is still valid: they
create a project at https://photon.codes and paste the project ID and
project secret into the settings app, or:

```bash
assistant credentials set --service imessage --field photon_project_id <id>
assistant credentials set --service imessage --field photon_project_secret <secret>
```

## 2. Store the credentials

Photon device login (step 1) already stored the pair. Skip this step unless
they used the manual fallback.

The settings app is the shortest manual path: open the iMessage plugin's
settings and fill in Photon's fields. It stores them in the credential store
and restarts the channel.

Never put a secret in `config.json` and never paste one into chat. The plugin
reads them from the credential store at call time, so rotating one later needs
no restart.

## 3. Allow the people Photon may message

Photon will only message numbers the project already knows. Anyone else is
refused with `Target not allowed for this project` — a policy answer that
reads like a bad address. The plugin registers a recipient on the first send,
but a setup check is that first send, so it fails unless the number is allowed
first.

Storing the credentials (device login or step 2) is what lets the channel
come up. Webhook mode then registers the endpoint and allows every phone
number already on the assistant's contacts. Live mode allows the same
contacts when ingress starts.
If that list was empty, unreadable, or the number you want to text is not a
contact yet, allow it by hand:

```bash
# Every contact that already has a phone number
bun skills/imessage-setup/scripts/allow.ts --contacts

# One number — the user's own, a test recipient, someone not yet a contact
bun skills/imessage-setup/scripts/allow.ts --to "+15551234567"
```

`--to` accepts E.164 (`+15551234567`) or a US national number; anything else
is rejected rather than guessed at. Linq and Comms have no such restriction.
Skip this step there.

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

Photon defaults to live gRPC (`ingressMode: "live"`) that reads inbound
off the same message-plane connection send already uses. It needs no public
URL and no webhook secret. Webhook mode is still available when the provider
can reach this assistant. Linq and Comms have no live stream and read as
webhook. Linq pins `?version=2026-02-03` on its registration URL so the
payload stays `data.sender_handle` / `data.chat.id`.

## Configuration

Optional, in the plugin's `config.json`:

| Key | Default | Meaning |
| --- | --- | --- |
| `provider` | `"photon"` | `"photon"`, `"linq"`, or `"comms"`. Set it from the settings app, which restarts ingress; editing it here needs a reload. |
| `ingressMode` | `"live"` | `"live"` (Photon gRPC stream, the default), `"webhook"`, or `"poll"`. Set it from the settings app, which restarts ingress. Linq and Comms have no live stream, so `"live"` is read as `"webhook"`. |
| `pollIntervalMs` | `5000` | Delay between polls, 2000 to 300000. Poll mode only, and not surfaced in the settings app. |

## Troubleshooting

Read [`references/troubleshooting.md`](references/troubleshooting.md) when a
step fails. It covers each symptom the two providers produce — missing
credentials, Photon's `Target not allowed for this project`, Comms scope
errors, and sends that succeed while nothing arrives. The Photon allow script
is in this skill: `scripts/allow.ts`.
