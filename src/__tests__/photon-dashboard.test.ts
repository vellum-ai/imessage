/**
 * Dashboard device-login client.
 *
 * Photon's approval page is what the user sees; this file covers the
 * machine half: minting a device code, polling until approve/deny/timeout,
 * and turning a session into a project id plus secret.
 */

import { describe, expect, test } from "bun:test";

import {
  PHOTON_DASHBOARD_BASE,
  PHOTON_DEVICE_CLIENT_ID,
  PhotonDashboardClient,
  PhotonDashboardError,
} from "../providers/photon/dashboard.ts";

interface FetchCall {
  url: string;
  method: string;
  body?: unknown;
}

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function clientWith(
  handler: (call: FetchCall) => Response,
  extras: ConstructorParameters<typeof PhotonDashboardClient>[0] = {},
): { client: PhotonDashboardClient; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const client = new PhotonDashboardClient({
    fetch: async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body =
        typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
      const call = { url, method, body };
      calls.push(call);
      return handler(call);
    },
    sleep: async () => {},
    now: () => 1_000,
    ...extras,
  });
  return { client, calls };
}

describe("PhotonDashboardClient.requestDeviceCode", () => {
  test("posts the published CLI client id", async () => {
    const { client, calls } = clientWith(() =>
      jsonResponse(200, {
        device_code: "dev-1",
        user_code: "J68Q-KGDH",
        verification_uri: "https://app.photon.codes/sign-in/device",
        verification_uri_complete:
          "https://app.photon.codes/sign-in/device/approve?user_code=J68QKGDH",
        expires_in: 600,
        interval: 5,
      }),
    );

    const challenge = await client.requestDeviceCode();

    expect(calls[0]?.url).toBe(`${PHOTON_DASHBOARD_BASE}/api/auth/device/code`);
    expect(calls[0]?.body).toMatchObject({ client_id: PHOTON_DEVICE_CLIENT_ID });
    expect(challenge.userCode).toBe("J68Q-KGDH");
    expect(challenge.verificationUriComplete).toContain("user_code=J68QKGDH");
  });

  test("refuses a body that is missing the codes", async () => {
    const { client } = clientWith(() => jsonResponse(200, { ok: true }));
    await expect(client.requestDeviceCode()).rejects.toBeInstanceOf(PhotonDashboardError);
  });
});

describe("PhotonDashboardClient.pollForToken", () => {
  const challenge = {
    deviceCode: "dev-1",
    userCode: "ABCD-1234",
    verificationUri: "https://app.photon.codes/sign-in/device",
    expiresIn: 30,
    interval: 5,
  };

  test("returns the access_token after authorization_pending", async () => {
    let n = 0;
    const { client } = clientWith(() => {
      n += 1;
      if (n === 1) {
        return jsonResponse(400, { error: "authorization_pending" });
      }
      return jsonResponse(200, { access_token: "tok-live" });
    });

    await expect(client.pollForToken(challenge)).resolves.toBe("tok-live");
  });

  test("reads the token from set-auth-token when the body has none", async () => {
    const { client } = clientWith(() =>
      jsonResponse(200, { session: {} }, { "set-auth-token": "tok-header" }),
    );

    await expect(client.pollForToken(challenge)).resolves.toBe("tok-header");
  });

  test("aborts on access_denied", async () => {
    const { client } = clientWith(() => jsonResponse(400, { error: "access_denied" }));

    await expect(client.pollForToken(challenge)).rejects.toThrow(/access_denied/);
  });

  test("times out when the deadline passes", async () => {
    let now = 1_000;
    const { client } = clientWith(
      () => jsonResponse(400, { error: "authorization_pending" }),
      {
        now: () => now,
        sleep: async () => {
          now += 60_000;
        },
      },
    );

    await expect(client.pollForToken({ ...challenge, expiresIn: 10 })).rejects.toThrow(
      /timed out/,
    );
  });
});

describe("PhotonDashboardClient projects", () => {
  test("finds a project by name and regenerates its secret", async () => {
    const { client } = clientWith((call) => {
      if (call.url.endsWith("/api/projects") && call.method === "GET") {
        return jsonResponse(200, {
          projects: [{ id: "proj-1", name: "Vellum Assistant" }],
        });
      }
      if (call.url.includes("/regenerate-secret")) {
        return jsonResponse(200, { projectSecret: "secret-1" });
      }
      return jsonResponse(404, { error: "missing" });
    });

    const found = await client.findProjectByName("tok", "vellum assistant");
    expect(found).toEqual({ id: "proj-1", name: "Vellum Assistant" });
    await expect(client.regenerateProjectSecret("tok", "proj-1")).resolves.toBe(
      "secret-1",
    );
  });

  test("creates a project when the body returns an id", async () => {
    const { client, calls } = clientWith(() =>
      jsonResponse(200, { id: "proj-new", name: "Vellum Assistant" }),
    );

    const created = await client.createProject("tok", "Vellum Assistant");
    expect(created.id).toBe("proj-new");
    expect(calls[0]?.body).toMatchObject({
      name: "Vellum Assistant",
      template: false,
    });
  });
});
