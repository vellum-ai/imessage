---
name: imessage-setup
description: Make the assistant reachable by iMessage and SMS. Use when the user wants to text the assistant, mentions iMessage or SMS setup, or when the imessage channel is not receiving messages.
---

# iMessage setup

Makes the assistant reachable by text message. Delivery is iMessage where the
recipient supports it, SMS otherwise.

## Set expectations first

Say this before starting, because it is usually not what people picture:

- People reach the assistant by texting **a line the assistant listens on**,
  not the user's own number.
- The assistant does not read the user's personal iMessage account or history.

Do not tell the user the assistant gets a dedicated number of its own. On the
default Vellum-provided path the line is shared for now, so promising a
private number would be a promise the product does not currently keep. A user
who needs a line of their own wants the bring-your-own-account path below.

If the user wanted the assistant to read and answer their existing personal
iMessage threads, this is the wrong tool. Say so plainly rather than
proceeding.

## Default path

Enable the iMessage channel for the assistant. Vellum provides the line, so
there is no third-party account to create and no key to paste.

Confirm it came up:

```bash
assistant plugins list
```

Then have the user text the assistant's line from their own phone and
confirm it lands.

That is the whole setup. Do not walk a user through anything below unless the
default path is unavailable to them or they ask for it.

## Configuration

Optional, in the plugin's `config.json`:

| Key | Default | Meaning |
| --- | --- | --- |
| `provider` | `"vellum"` | `"vellum"` (Vellum-provided line) or `"comms"` (bring your own account). |
| `ingressMode` | `"webhook"` | `"webhook"` (default) or `"poll"` for deployments with no public ingress. |
| `pollIntervalMs` | `5000` | Delay between polls, 2000 to 300000. Poll mode only. |
| `sendChannel` | unset | Force `"sms"` or `"imessage"`. Unset lets the provider choose, which is almost always right. |
| `allowedHandles` | `[]` | E.164 handles allowed through. Empty allows all. |

`allowedHandles` is a coarse pre-filter for a line shared with something else,
not a security control. The assistant's admission policy is the real gate, and
it applies either way.

## Testing outbound before inbound works

Inbound does not reach the assistant yet on any provider, and outbound only
works on the bring-your-own-account path. See
[references/testing-outbound.md](references/testing-outbound.md) when the user
wants to verify sending works.

## Bring your own account

Some users want to run the channel on their own Comms by Osis workspace
instead of the Vellum-provided line. That path also gets them a line of their
own. See [references/comms.md](references/comms.md).

## Troubleshooting

**The assistant has no line** — the iMessage channel is not enabled for this
assistant yet. Enable it; the plugin stays idle until a line exists.

**Messages sent before setup do not appear** — expected. The channel starts
from the moment of setup rather than replaying history.

**Replies contain stray punctuation** — report it. The plugin flattens
markdown before sending because iMessage renders none, and a gap in that
flattening is a bug worth fixing rather than working around.
