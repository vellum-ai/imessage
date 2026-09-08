---
name: imessage-setup
description: Set up the iMessage channel with the user's own Photon, Linq, or Comms account so the assistant can send and receive texts. After the provider is stored, save and verify the user's iMessage handle on their guardian contact if it is missing. Use when the user wants to text the assistant, when a send fails with a missing credential or 401, or when the channel reports it is idle.
metadata:
  emoji: "💬"
  vellum:
    category: "messaging"
    display-name: "iMessage Setup"
---

Connects the iMessage channel to the user's own [Photon](https://photon.codes)
line by default. [Linq](https://dashboard.linqapp.com/sandbox) and
[Comms by Osis](https://comms.osis.co) are also supported when the user asks
for them.

## Hard rules

- **Send the Photon approval URL once, in chat, in the same turn as `--start`.**
  Paste it as a markdown link. That URL already signs them in. Do not also
  send `https://photon.codes` or `https://app.photon.codes`. Do not run
  `--finish` in the same turn as `--start`. `--finish` blocks until they
  approve, so running it before they have the link means they never see it.
- **Collect a missing project ID and project secret with
  `assistant credentials prompt`.** Never ask for them in chat. Never pass
  them to `assistant credentials set`. The CLI refuses inline user-supplied
  values from an agent shell.
- **Do not restart the assistant.** Do not tell the user to restart it.
  Storing credentials takes effect on the next send. Channel ingress comes
  up on its own after a successful store. Restarting is never part of setup.
- **Keep the settings panel in the background.** Do not mention it, do not
  open it, and do not send the user there to fill fields. Conversational
  setup (device login, or credential prompts) is the path.

## Set expectations first

Say this before starting, because it is usually not what people picture:

- The user creates their **own** account with Photon, Linq, or Comms, and
  their own line. There is no number provided for them.
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

Photon is the default and the path this skill walks.

- Linq: collect a V3 API token from https://dashboard.linqapp.com/sandbox
  with `assistant credentials prompt --service imessage --field linq_api_key`.
- Comms: collect a Messages API key from https://comms.osis.co with
  `comms_send` and `comms_read` (`comms_webhooks` too if inbound is webhook).
  Scopes are fixed at key creation, so a key missing one has to be replaced.
  Collect it with `assistant credentials prompt --service imessage --field api_key`.

## 1. Create the line and get credentials

**Photon (preferred):** do not send the user to copy a project secret. Run the
device login so Photon creates or reuses a project named "Vellum Assistant"
and this plugin stores the id and secret itself.

```bash
bun skills/imessage-setup/scripts/connect.ts --start
```

`--start` prints one approval URL and a short code, then exits. In **this
same turn**, before any other command:

1. Reply with that URL as a markdown link, for example
   `[Approve Photon](https://app.photon.codes/sign-in/device/approve?user_code=...)`.
2. Include the short code so they can confirm it matches.
3. Tell them to click Approve.
4. Stop. Do not run `--finish` yet.

The printed URL is the only Photon link to send. It already takes them
through sign-in. Sending `https://photon.codes` or
`https://app.photon.codes` as well is a second, useless trip.

On the **next** turn, after they have the link (they said they approved, or
they came back), run:

```bash
bun skills/imessage-setup/scripts/connect.ts --finish
```

`--finish` waits until they approve, then writes `photon_project_id` and
`photon_project_secret` to the credential store. It never prints the secret.
If they already have a "Vellum Assistant" project, it reuses it and rotates
that project's secret. Pass `--force` on both commands only when they asked
to reconnect.

If device login is unavailable (`invalid_client`, timeout, `access_denied`),
use the manual fallback below. Do not invent a restart to recover.

### Manual fallback: prompt for project ID and project secret

They create a project at https://photon.codes if they do not have one yet.
Then collect the two fields with secure prompts, **in this order**, never
in chat:

Tell them the first prompt is for the project ID, then:

```bash
assistant credentials prompt \
  --service imessage \
  --field photon_project_id \
  --label "Photon project ID" \
  --description "Paste the project ID from your Photon project page." \
  --placeholder "Project ID"
```

After that prompt returns 0, tell them the next prompt is for the project
secret, then:

```bash
assistant credentials prompt \
  --service imessage \
  --field photon_project_secret \
  --label "Photon project secret" \
  --description "Paste the project secret from the same Photon project. It is shown once." \
  --placeholder "Project secret"
```

Each command blocks until they submit. Tell them what to paste **before**
running it. Exit code **130** means they cancelled: nothing was stored; ask
whether they want to try again. Any other non-zero exit is a real failure.

Never put a secret in `config.json`. Never paste one into chat. Never pass a
user-typed value to `assistant credentials set`.

## 2. Store the credentials

Photon device login (step 1) already stored the pair. Skip this step unless
they used the manual fallback, which already prompted.

The plugin reads credentials from the store at call time, so rotating one
later needs no restart of the assistant.

## 3. Save and verify the user's iMessage handle

Inbound from a handle that is not a verified iMessage identity on the
guardian is classified unknown and denied under the default plugin floor.
A number that is only verified on Phone Calling is still unknown on
iMessage. A number that only appeared in chat history is not on the
contact graph.

After the provider is stored, check:

```bash
bun skills/imessage-setup/scripts/guardian-imessage.ts
```

The script prints one of:

- `{ "found": true, "address": "+15551234567", "verified": true }` — already
  attested. Say so and skip the rest of this step.
- `{ "found": true, "address": "+15551234567", "verified": false }` — stored
  but not attested. Open the prompt below with `--default-value` set to
  `address`.
- `{ "found": false, "suggested": "+15551234567" }` — no iMessage row yet.
  A Phone Calling number is only a prefill. Open the prompt with
  `--default-value` set to `suggested` unless this conversation already
  has their number.
- `{ "found": false }` — nothing to prefill. Open the prompt. If this
  conversation already has their number, pass it as `--default-value` in
  E.164. Do not invent a number.

Explain that texts from their phone will not be recognized until this
handle is saved and verified. Do **not** ask them to type the number in
chat.

```bash
assistant contacts prompt \
  --channel imessage \
  --role guardian \
  --verify \
  --label "Your iMessage number" \
  --description "Save the number you text from so the assistant can recognize you on this line." \
  --placeholder "+15551234567"
```

`--verify` attests the submitted handle the same way Contacts Verify me
does. That writes the inbound identity the plugin floor looks up.
Without it the address is stored unverified and inbound stays unknown.

`--role guardian` binds the channel to the existing guardian contact.

If `--verify` is rejected as an unknown flag, this assistant is older
than the verified-prompt flow. Run the same command without `--verify`,
then ask them to open Contacts and click **Verify me** next to iMessage.

If they dismiss the prompt or it fails, continue setup. Warn that inbound
from their phone will stay unknown until the iMessage handle is on the
guardian contact and verified. Do not retry the prompt unless they ask.

## 4. Allow the people Photon may message

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

## 5. Confirm sending works

```bash
bun skills/imessage/scripts/send.ts --to "<the user's own number>" --body "Setup check from your assistant."
```

If step 3 found or saved a number, use that as `--to`. Have the user confirm
it arrived. The script sends through the same provider
adapter the channel uses, over whichever line `config.json` names, so this
isolates a credential problem from an ingress problem on either provider. If
Photon still answers `Target not allowed for this project`, the number was not
allowed — go back to step 4 rather than rotating credentials.

## 6. Inbound

**Use webhook** when the provider can reach this assistant. The plugin
registers the endpoint on every webhook-mode start at
`/webhooks/plugins/imessage/events-<provider>`. The public base comes from
the host (a managed platform callback route, or a configured public
ingress), so there is nothing to compose or configure here. On Photon,
that same start also allows the assistant's contact phone numbers
(step 4); a number added as a contact later still needs `allow.ts`.

Photon defaults to live gRPC (`ingressMode: "live"`) that reads inbound
off the same message-plane connection send already uses. It needs no public
URL and no webhook secret. Webhook mode is still available when the
provider can reach this assistant. Linq and Comms have no live stream and
read as webhook. Linq pins `?version=2026-02-03` on its registration URL
so the payload stays `data.sender_handle` / `data.chat.id`.

Polling is the fallback when the provider cannot reach this assistant:

```json
{ "ingressMode": "poll", "pollIntervalMs": 5000 }
```

Polling needs `comms_read` on Comms, runs in its own worker process, and
starts from the moment it is enabled rather than replaying the line's
history. It costs latency and burns requests while the line is quiet.

## Configuration

Optional, in the plugin's `config.json`:

| Key | Default | Meaning |
| --- | --- | --- |
| `provider` | `"photon"` | `"photon"`, `"linq"`, or `"comms"`. Changing it restarts channel ingress, not the assistant. |
| `ingressMode` | `"live"` | `"live"` (Photon gRPC stream, the default), `"webhook"`, or `"poll"`. Changing it restarts channel ingress. Linq and Comms have no live stream, so `"live"` is read as `"webhook"`. |
| `pollIntervalMs` | `5000` | Delay between polls, 2000 to 300000. Poll mode only. |

## Troubleshooting

Read [`references/troubleshooting.md`](references/troubleshooting.md) when a
step fails. It covers each symptom the providers produce: missing
credentials, Photon's `Target not allowed for this project`, Comms scope
errors, and sends that succeed while nothing arrives. The Photon allow script
is in this skill: `scripts/allow.ts`.
