# Bring your own Comms account

The default setup uses the Vellum-provided line and needs none of this.
Follow this path only when the user explicitly wants the channel running on
their own [Comms by Osis](https://comms.osis.co) workspace.

Trade-off worth stating up front: BYOK gets the user a line of their own,
which the default Vellum path does not today — it also means they own the
billing, the setup, the rotation, and anything that breaks. The Vellum path is
faster and has fewer moving parts.

## 1. Create the line and mint an API key

Direct the user to https://comms.osis.co to create a workspace, provision a
line, and mint a Messages API key from the dashboard.

Scopes the key needs:

| Scope | Needed for |
| --- | --- |
| `comms_send` | Sending replies |
| `comms_read` | Poll ingress only |
| `comms_webhooks` | Registering the webhook endpoint |

`comms_send` is always required. `comms_read` is only needed in poll mode, but
minting it up front avoids a second trip: scopes are fixed at creation, so a
key missing one has to be replaced rather than upgraded.

## 2. Store the key

```bash
assistant credentials set --service imessage --field api_key <key>
```

Never paste the key into `config.json` or into chat. The plugin reads it from
the credential store at call time, so rotating it later needs no restart.

## 3. Point the plugin at it

In the plugin's `config.json`:

```json
{ "provider": "comms" }
```

Webhook ingress stays the default. Register the endpoint with Comms, pointing
at `<public ingress URL>/webhooks/plugins/imessage/events`. Get the base from:

```bash
assistant config get ingress.publicBaseUrl
```

Never hardcode a host. The gateway verifies the delivery signature before the
plugin sees it, so there is nothing to configure on the plugin side for that.

A guardian must approve the plugin's ingress declaration before the gateway
serves the route.

## 4. If the gateway is not reachable from the internet

Self-hosted deployments behind NAT cannot receive webhooks. Switch to polling:

```json
{ "provider": "comms", "ingressMode": "poll", "pollIntervalMs": 5000 }
```

The key must carry `comms_read` for this. Polling runs in its own worker
process and starts from the moment it is enabled rather than replaying the
line's history.

Polling costs latency (a message becomes a turn within one interval instead of
within a second) and burns requests while the line is quiet. Prefer webhooks
where the deployment allows them.

## API reference

Base `https://osis.co/api/v1/comms`, bearer auth.

| Endpoint | Purpose |
| --- | --- |
| `POST /messages` | Send. `{ to \| conversation_id, body, channel?, idempotency_key? }`. 202 on send, 200 with `duplicate: true` on an idempotency-key collision. |
| `GET /messages` | List. `conversation_id`, `since` (ISO-8601), `direction`, `limit`. |
| `POST /webhooks` | Register an endpoint. `{ url, events }`. |
| `GET /webhooks` | List registered endpoints. |

Event types include `message.received` and `message.sent`.

## Troubleshooting

**"Comms API key not found"** — the credential was not stored, or was stored
under a different service name. Check with `assistant credentials list`.

**Assistant sends but never receives** — in poll mode, the key is missing
`comms_read`. In webhook mode, the endpoint is not registered or the guardian
has not approved the ingress declaration.

**Nothing arrives after switching to webhook mode** — confirm the registered
URL matches the current `ingress.publicBaseUrl`. A tunnel URL that changed
since registration is the usual cause.
