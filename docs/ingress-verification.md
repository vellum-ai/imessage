# Generic webhook verification for plugin ingress

A proposal, written from the imessage plugin and addressed to the gateway. The
manifest in `channels/ingress.json` is already written in the shape described
here, so this doubles as the reference implementation's declaration.

## The problem

`gateway/src/http/routes/plugin-webhook.ts` verifies every delivery to
`/webhooks/plugins/<plugin>/<path>` one way:

```
Vellum-Signature: sha256=<hex HMAC-SHA256(rawBody, <plugin>/webhook_secret)>
```

That is the platform's own scheme. It works when Vellum is the caller. It
cannot work for a third-party service, which signs the way *it* signs, and
`IngressRouteSchema` has no field that could say otherwise — `signer` picks
whose secret, `handshake` picks header-versus-query and is websocket-only.

So today a plugin can declare a public route for a vendor webhook, register
that URL with the vendor, and watch every delivery 403.

The imessage plugin needs two vendors at once, and they differ:

| | Photon (Spectrum) | Comms by Osis |
| --- | --- | --- |
| Signs? | Yes | **No** — documents no signature and issues no signing secret |
| Header | `X-Spectrum-Signature: v0=<hex>` | — |
| Signed bytes | `"v0:" + timestamp + ":" + rawBody` | — |
| Replay guard | `X-Spectrum-Timestamp`, 5 minutes | — |
| Secret source | returned once from `POST /webhooks/` | none; the plugin mints one |

Hard-coding either in gateway code solves this repo and no other. The point of
the descriptor below is that the *next* vendor is a manifest edit.

## Where the provider comes from

The plugin's provider is a runtime choice — a user picks Comms or Photon in the
settings app — while the manifest is static. Reading plugin config from the
gateway to pick a verification scheme would be the wrong direction of
dependency.

**One route per provider** removes the question. The provider is a path
segment, so which scheme applies is decided by which URL the vendor was told to
deliver to, and the gateway reads only its own static file:

```
/webhooks/plugins/imessage/events/comms
/webhooks/plugins/imessage/events/photon
```

The plugin registers the matching URL with whichever provider is configured.
Nothing dynamic crosses the boundary.

## The descriptor

An optional `verification` object per route. Absent means today's behaviour —
the platform scheme against `signer`'s secret — so every existing manifest
keeps working and this is additive.

### `kind: "hmac"`

```jsonc
{
  "path": "events/photon",
  "kind": "http",
  "description": "Inbound message webhooks from a Photon project.",
  "verification": {
    "kind": "hmac",
    "algorithm": "sha256",
    "secret": { "field": "photon_webhook_secret" },
    "signature": {
      "header": "X-Spectrum-Signature",
      "encoding": "hex",
      "prefix": "v0="
    },
    "payload": [
      { "literal": "v0:" },
      { "header": "X-Spectrum-Timestamp" },
      { "literal": ":" },
      "body"
    ],
    "freshness": {
      "header": "X-Spectrum-Timestamp",
      "format": "unix-seconds",
      "toleranceSeconds": 300
    }
  }
}
```

- **`algorithm`** — `sha1` | `sha256` | `sha512`.
- **`secret.field`** — credential field under **the declaring plugin's own
  service**. The service is never declarable: composing it gateway-side from
  the plugin's directory name is what stops a manifest naming another plugin's
  secret. This generalizes the existing fixed `webhook_secret`, which the
  current code already flags as a later step.
- **`signature`** — where the digest is and how it is written.
  `prefix` is stripped before comparison. For vendors that pack several values
  into one header (Stripe's `t=…,v1=…`, Svix's `v1,<b64> v2,<b64>`), a
  `select: { entrySeparator, pairSeparator, key }` picks one out; the same
  selector is what a `payload` part needs to reference `t`. Not required by
  either vendor here, and the shape leaves room for it.
- **`payload`** — the exact bytes to sign, in order. `"body"` is the raw body
  as received; `{ "header": … }` and `{ "literal": … }` are the rest. A header
  named here but absent from the request fails verification rather than
  contributing an empty string, or a caller could omit the timestamp to change
  what was signed.
- **`freshness`** — optional replay guard. `format` covers `unix-seconds`,
  `unix-millis`, `rfc3339`.

Comparison is constant-time on the decoded digest bytes.

### `kind: "shared-secret"`

```jsonc
{
  "path": "events/comms",
  "kind": "http",
  "description": "Inbound message webhooks from a Comms by Osis line.",
  "verification": {
    "kind": "shared-secret",
    "secret": { "field": "comms_webhook_token" },
    "carrier": { "query": "token" }
  }
}
```

For vendors that do not sign at all. The plugin mints a 256-bit token, stores
it under `secret.field`, and registers a URL carrying it; the gateway compares
in constant time and forwards. `carrier` is `{ "query": <name> }` or
`{ "header": <name> }`.

This is weaker than an HMAC and should be described as such wherever it
surfaces: the URL is a bearer credential, so it must not be logged. Suggest the
gateway strip the carrier parameter from request logs for these routes, and
strip it from the forwarded request too — the plugin has no use for it.

It is still strictly better than the alternatives, which are an unsigned public
endpoint or no webhook support for a vendor that will not sign.

## Notes for the implementation

- **Fail closed on anything unrecognized.** An unknown `kind`, algorithm, or
  encoding must refuse the route, not fall through to the platform scheme. A
  gateway that silently ignored a descriptor it did not understand would serve
  a route the plugin believes is verified one way and is verified another.
- **The descriptor is part of the approval digest**, exactly as `signer` and
  `handshake` are. Loosening verification is precisely the change a guardian
  should be asked about again.
- **Body limits and rate limiting stay where they are**, ahead of verification.
- **Plugins do not verify.** This proposal exists so that stays true: the whole
  reason the imessage plugin refuses to check signatures itself is that two
  implementations of one scheme is one of them being subtly wrong.
