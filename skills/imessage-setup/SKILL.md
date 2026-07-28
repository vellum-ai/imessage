---
name: imessage-setup
description: Give the assistant a phone number so people can reach it by iMessage and SMS. Use when the user wants the assistant reachable by text message, mentions iMessage or SMS setup, or when the imessage channel is not receiving messages.
---

# iMessage setup

Gives the assistant a phone number that people can text. Delivery is iMessage
where the recipient supports it, SMS otherwise.

## Set expectations first

Say this before starting, because it is usually not what people picture:

- The assistant gets **its own number**. It does not read the user's personal
  iMessage account or history.
- People text **that number** to reach the assistant. The user will too.

If the user wanted the assistant to read and answer their existing personal
iMessage threads, this is the wrong tool. Say so plainly rather than
proceeding.

## Default path

Enable the iMessage channel for the assistant. The platform provisions the
line, so there is no third-party account to create and no key to paste.

Confirm it came up:

```bash
assistant plugins list
```

Then have the user text the assistant's number from their own phone and
confirm it lands.

That is the whole setup. Do not walk a user through anything below unless the
default path is unavailable to them or they ask for it.

## Configuration

Optional, in the plugin's `config.json`:

| Key | Default | Meaning |
| --- | --- | --- |
| `provider` | `"vellum"` | `"vellum"` (platform-provisioned) or `"comms"` (bring your own account). |
| `ingressMode` | `"webhook"` | `"webhook"` (default) or `"poll"` for deployments with no public ingress. |
| `pollIntervalMs` | `5000` | Delay between polls, 2000 to 300000. Poll mode only. |
| `sendChannel` | unset | Force `"sms"` or `"imessage"`. Unset lets the provider choose, which is almost always right. |
| `allowedHandles` | `[]` | E.164 handles allowed through. Empty allows all. |

`allowedHandles` is a coarse pre-filter for a line shared with something else,
not a security control. The assistant's admission policy is the real gate, and
it applies either way.

## Bring your own account

Some users want to run the channel on their own Comms by Osis workspace
instead of the platform-provisioned line. See
[references/comms.md](references/comms.md) for that path.

## Troubleshooting

**The assistant has no number** — the iMessage channel is not enabled for this
assistant yet. Enable it; the plugin stays idle until a line exists.

**Messages sent before setup do not appear** — expected. The channel starts
from the moment of setup rather than replaying history.

**Replies contain stray punctuation** — report it. The plugin flattens
markdown before sending because iMessage renders none, and a gap in that
flattening is a bug worth fixing rather than working around.
