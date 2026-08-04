/**
 * `channels/ingress.json` against the code that has to agree with it.
 *
 * The manifest is read by the *gateway*, and nothing in this plugin's type
 * system reaches it. So every fact it states twice — one route per provider,
 * the path each provider registers, the credential field each verification
 * reads — is a fact that can drift silently, and the symptom is deliveries
 * failing verification with everything looking correct on both sides.
 *
 * These tests are the join. They are deliberately about agreement rather than
 * about the manifest's own shape: the gateway validates that.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  WEBHOOK_SECRET_FIELDS,
  WEBHOOK_VERIFICATION,
} from "../config.ts";
import type { ProviderId } from "../providers/types.ts";
import { PROVIDER_IDS } from "../providers/types.ts";
import {
  ingressRoutePath,
  SHARED_SECRET_PARAM,
} from "../webhook-endpoint.ts";

const ROOT = join(import.meta.dir, "..", "..");

interface ManifestRoute {
  path: string;
  kind: string;
  description: string;
  verification?: {
    kind?: string;
    algorithm?: string;
    secret?: { field?: string };
    carrier?: { query?: string; header?: string };
    signature?: { header?: string; encoding?: string; prefix?: string };
    payload?: unknown[];
    freshness?: { header?: string; toleranceSeconds?: number };
  };
}

const manifest = JSON.parse(
  readFileSync(join(ROOT, "channels", "ingress.json"), "utf8"),
) as { routes: ManifestRoute[] };

function routeFor(provider: ProviderId): ManifestRoute | undefined {
  return manifest.routes.find(
    (route) => route.path === ingressRoutePath(provider),
  );
}

describe("ingress manifest", () => {
  test("declares one route per provider", () => {
    // A provider with no route has nowhere to deliver; a route with no
    // provider is a public surface nothing answers on.
    expect(manifest.routes).toHaveLength(PROVIDER_IDS.length);
    for (const provider of PROVIDER_IDS) {
      expect(routeFor(provider)).toBeDefined();
    }
  });

  test("every route has a handler file on disk", () => {
    // The gateway forwards to `/v1/x/plugins/<plugin>/<path>`, which the
    // runtime resolves against `routes/<path>.ts`. A declared route with no
    // file is an approved public path that 404s.
    for (const route of manifest.routes) {
      expect(existsSync(join(ROOT, "routes", `${route.path}.ts`))).toBe(true);
    }
  });

  test("each route names the credential field the plugin stores", () => {
    // The plugin writes the secret; the gateway reads it. They meet only here.
    for (const provider of PROVIDER_IDS) {
      expect(routeFor(provider)?.verification?.secret?.field).toBe(
        WEBHOOK_SECRET_FIELDS[provider],
      );
    }
  });

  test("each route's verification kind matches what the runtime does", () => {
    // `shared-secret` means the runtime mints a token and puts it in the URL.
    // Declaring `hmac` for such a provider would have the gateway look for a
    // signature nobody sends.
    for (const provider of PROVIDER_IDS) {
      expect(routeFor(provider)?.verification?.kind).toBe(
        WEBHOOK_VERIFICATION[provider],
      );
    }
  });

  test("the shared-secret route carries the token the runtime appends", () => {
    const comms = routeFor("comms");
    expect(comms?.verification?.carrier?.query).toBe(SHARED_SECRET_PARAM);
  });

  test("the hmac route describes Photon's documented scheme", () => {
    // `HMAC-SHA256(secret, "v0:" + timestamp + ":" + rawBody)`, hex, sent as
    // `X-Spectrum-Signature: v0=<hex>` with a five-minute tolerance.
    const photon = routeFor("photon")?.verification;

    expect(photon?.algorithm).toBe("sha256");
    expect(photon?.signature).toMatchObject({
      header: "X-Spectrum-Signature",
      encoding: "hex",
      prefix: "v0=",
    });
    expect(photon?.payload).toEqual([
      { literal: "v0:" },
      { header: "X-Spectrum-Timestamp" },
      { literal: ":" },
      "body",
    ]);
    expect(photon?.freshness).toMatchObject({
      header: "X-Spectrum-Timestamp",
      toleranceSeconds: 300,
    });
  });

  test("every route is http and carries a description", () => {
    // The gateway rejects a manifest without one, and the description is what
    // a guardian reads when approving the route.
    for (const route of manifest.routes) {
      expect(route.kind).toBe("http");
      expect(route.description.length).toBeGreaterThan(0);
    }
  });
});
