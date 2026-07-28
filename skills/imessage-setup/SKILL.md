---
name: imessage-setup
description: Connect the assistant to an iMessage and SMS line via Comms by Osis. Use when the user wants the assistant reachable by text message, mentions iMessage or SMS setup, or when the imessage plugin reports a missing API key.
---

# iMessage setup

Connects the assistant to a **Comms by Osis** line so people can reach it by
iMessage or SMS.

## What the user is actually getting

Say this before starting, because it is usually not what people picture:

- The assistant gets **its own phone number**. It does not read, and cannot
  read, the user's personal iMessage account or history.
- People text **that number** to reach the assistant. The user themselves will
  text it too.
- Delivery is **iMessage where the recipient supports it, SMS otherwise**.
  Comms decides per recipient.

If the user wanted the assistant to read and answer their existing personal
iMessage thread, this is the wrong tool and no amount of setup will get there.
Say so plainly rather than proceeding.

## Steps

### 1. Create the line and mint an API key

Direct the user to https://comms.osis.co to create a workspace and provision a
line, then mint a Messages API key from the dashboard.

The key needs these scopes:

| Scope | Needed for |
| --- | --- |
| `comms_send` | Sending replies |
| `comms_read` | Polling for inbound messages (the default ingress mode) |
| `comms_webhooks` | Only if switching to webhook ingress |

`comms_read` is not optional. Without it the assistant can send but never sees
a reply, which presents as "the assistant ignores me".

### 2. Store the key

```bash
assistant credentials set --service imessage --field api_key <key>
```

Never paste the key into `config.json` or into chat. The plugin reads it from
the credential store at call time, so rotating it later needs no restart.

### 3. Confirm the channel came up

```bash
assistant plugins list
```

The `imessage` plugin should be loaded. It polls the Messages API every 5
seconds by default; a fresh install starts from the moment of setup, so
messages sent before this point will not appear.

### 4. Send a test message

Have the user text the line's number from their own phone and confirm the
message is picked up.

## Configuration

Optional, in the plugin's `config.json`:

| Key | Default | Meaning |
| --- | --- | --- |
| `ingressMode` | `"poll"` | `"poll"` or `"webhook"`. Leave as `poll`. |
| `pollIntervalMs` | `5000` | Delay between polls, 2000 to 300000. |
| `sendChannel` | unset | Force `"sms"` or `"imessage"`. Unset lets Comms choose, which is almost always right. |
| `allowedHandles` | `[]` | E.164 handles allowed through. Empty allows all. |

`allowedHandles` is a coarse pre-filter for a line shared with something else,
not a security control. The assistant's admission policy is the real gate, and
it applies either way.

## Webhook ingress

`ingressMode: "webhook"` is faster than polling but **not yet verified**: the
Comms webhook payload envelope and its signature scheme are not in the
published documentation, so the plugin's verification code is written against
the conventional shape rather than a confirmed one.

Do not switch a user to webhook mode as part of routine setup. If they ask:

1. Store the signing secret:
   ```bash
   assistant credentials set --service imessage --field webhook_secret <secret>
   ```
   Without it the route rejects every delivery. That is deliberate — an
   unauthenticated inbound-message endpoint lets anyone impersonate a trusted
   contact.
2. Set `ingressMode` to `"webhook"`.
3. A guardian must approve the plugin's ingress declaration before the gateway
   serves the route.
4. Register the endpoint with Comms, pointing at
   `<public ingress URL>/webhooks/plugins/imessage/events`. Get the base from
   `assistant config get ingress.publicBaseUrl` — never hardcode a host.

If deliveries are rejected after this, the signature scheme guess is wrong.
Fall back to `poll` and report it.

## Troubleshooting

**"Comms API key not found"** — step 2 was skipped or used the wrong service
name. Verify with `assistant credentials list`.

**Assistant sends but never receives** — the key is missing the `comms_read`
scope. Mint a new one; scopes are fixed at creation.

**Messages sent before setup do not appear** — expected. A fresh install polls
from the moment of setup rather than replaying the line's history.

**Replies look like they contain stray punctuation** — report it. The plugin
flattens markdown before sending because iMessage renders none, and a gap in
that flattening is a bug worth fixing rather than working around.
