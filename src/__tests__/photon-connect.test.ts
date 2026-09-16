/**
 * Device-flow connect orchestration.
 *
 * The script is a thin wrapper. These tests drive start/finish against a
 * fake dashboard and a fake credential store so a run never opens a browser
 * or writes a real secret.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  finishPhotonConnect,
  formatPhotonConnectStart,
  photonApprovalUrl,
  startPhotonConnect,
} from "../providers/photon/connect.ts";
import { PHOTON_DASHBOARD_BASE } from "../providers/photon/dashboard.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "imessage-photon-connect-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("startPhotonConnect", () => {
  test("skips the flow when Photon already answers", async () => {
    const started = await startPhotonConnect({
      storageDir: dir,
      isConnected: async () => true,
      fetch: async () => {
        throw new Error("dashboard should not be called");
      },
    });

    expect(started).toEqual({ alreadyConnected: true });
  });

  test("writes a pending login and returns the approval URL", async () => {
    const started = await startPhotonConnect({
      storageDir: dir,
      isConnected: async () => false,
      now: () => 5_000,
      fetch: async () =>
        jsonResponse(200, {
          device_code: "dev-1",
          user_code: "J68Q-KGDH",
          verification_uri: "https://app.photon.codes/sign-in/device",
          verification_uri_complete:
            "https://app.photon.codes/sign-in/device/approve?user_code=J68QKGDH",
          expires_in: 600,
          interval: 5,
        }),
    });

    expect(started.alreadyConnected).toBe(false);
    expect(started.userCode).toBe("J68Q-KGDH");
    expect(photonApprovalUrl(started)).toBe(
      "https://app.photon.codes/sign-in/device/approve?user_code=J68QKGDH",
    );
    const pending = JSON.parse(
      readFileSync(join(dir, "photon-device-login.json"), "utf8"),
    ) as { deviceCode: string; expiresAt: number };
    expect(pending.deviceCode).toBe("dev-1");
    expect(pending.expiresAt).toBe(5_000 + 600_000);
  });
});

describe("formatPhotonConnectStart", () => {
  test("tells the assistant to send only this URL and wait a turn", () => {
    const message = formatPhotonConnectStart({
      alreadyConnected: false,
      userCode: "J68Q-KGDH",
      verificationUri: "https://app.photon.codes/sign-in/device",
      verificationUriComplete:
        "https://app.photon.codes/sign-in/device/approve?user_code=J68QKGDH",
    });

    expect(message).toContain(
      "https://app.photon.codes/sign-in/device/approve?user_code=J68QKGDH",
    );
    expect(message).toContain("Confirm the code matches: J68Q-KGDH");
    expect(message).toContain("Do not send any other Photon URL");
    expect(message).toContain("Do not run --finish until the next turn");
    expect(message).not.toContain("connect.ts --finish");
  });

  test("says so when Photon is already connected", () => {
    expect(formatPhotonConnectStart({ alreadyConnected: true })).toContain(
      "Photon is already connected",
    );
  });

  test("tells the assistant to finish an already-approved login without a new URL", () => {
    const message = formatPhotonConnectStart({
      alreadyConnected: false,
      alreadyApproved: true,
    });

    expect(message).toContain("Run connect.ts --finish");
    expect(message).toContain("Do not send a new approval URL");
    expect(message).not.toContain("app.photon.codes");
  });
});

describe("finishPhotonConnect", () => {
  test("polls, reuses a named project, stores the rotated secret", async () => {
    await startPhotonConnect({
      storageDir: dir,
      isConnected: async () => false,
      fetch: async () =>
        jsonResponse(200, {
          device_code: "dev-1",
          user_code: "ABCD-1234",
          verification_uri: "https://app.photon.codes/sign-in/device",
          expires_in: 600,
          interval: 5,
        }),
    });

    const stored: Record<string, string>[] = [];
    let polls = 0;
    const done = await finishPhotonConnect({
      storageDir: dir,
      isConnected: async () => false,
      projectName: "Vellum Assistant",
      sleep: async () => {},
      store: async (values) => {
        stored.push(values);
      },
      fetch: async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === `${PHOTON_DASHBOARD_BASE}/api/auth/device/token`) {
          polls += 1;
          if (polls === 1) {
            return jsonResponse(400, { error: "authorization_pending" });
          }
          return jsonResponse(200, { access_token: "tok-1" });
        }
        if (url === `${PHOTON_DASHBOARD_BASE}/api/projects` && method === "GET") {
          return jsonResponse(200, [{ id: "proj-1", name: "Vellum Assistant" }]);
        }
        if (url.endsWith("/regenerate-secret")) {
          return jsonResponse(200, { projectSecret: "secret-rotated" });
        }
        return jsonResponse(404, { error: "unexpected" });
      },
    });

    expect(done).toEqual({
      alreadyConnected: false,
      projectId: "proj-1",
      projectName: "Vellum Assistant",
      created: false,
    });
    expect(stored).toEqual([
      {
        photon_project_id: "proj-1",
        photon_project_secret: "secret-rotated",
      },
    ]);
  });

  test("creates the project when none matches the default name", async () => {
    await startPhotonConnect({
      storageDir: dir,
      isConnected: async () => false,
      fetch: async () =>
        jsonResponse(200, {
          device_code: "dev-1",
          user_code: "ABCD-1234",
          verification_uri: "https://app.photon.codes/sign-in/device",
          expires_in: 600,
          interval: 5,
        }),
    });

    const stored: Record<string, string>[] = [];
    const done = await finishPhotonConnect({
      storageDir: dir,
      isConnected: async () => false,
      sleep: async () => {},
      store: async (values) => {
        stored.push(values);
      },
      fetch: async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.endsWith("/api/auth/device/token")) {
          return jsonResponse(200, { access_token: "tok-1" });
        }
        if (url.endsWith("/api/projects") && method === "GET") {
          return jsonResponse(200, []);
        }
        if (url.endsWith("/api/projects") && method === "POST") {
          return jsonResponse(200, { id: "proj-new", name: "Vellum Assistant" });
        }
        if (url.endsWith("/regenerate-secret")) {
          return jsonResponse(200, { projectSecret: "secret-new" });
        }
        return jsonResponse(404, { error: "unexpected" });
      },
    });

    expect(done.created).toBe(true);
    expect(done.projectId).toBe("proj-new");
    expect(stored[0]?.photon_project_secret).toBe("secret-new");
  });

  test("refuses finish when start has not run", async () => {
    await expect(
      finishPhotonConnect({
        storageDir: dir,
        isConnected: async () => false,
      }),
    ).rejects.toThrow(/No Photon login is in progress/);
  });

  test("clears the pending login when the poll fails", async () => {
    await startPhotonConnect({
      storageDir: dir,
      isConnected: async () => false,
      fetch: async () =>
        jsonResponse(200, {
          device_code: "dev-1",
          user_code: "ABCD-1234",
          verification_uri: "https://app.photon.codes/sign-in/device",
          expires_in: 600,
          interval: 5,
        }),
    });

    await expect(
      finishPhotonConnect({
        storageDir: dir,
        isConnected: async () => false,
        sleep: async () => {},
        fetch: async (input) => {
          if (String(input).endsWith("/api/auth/device/token")) {
            return jsonResponse(400, { error: "invalid_grant" });
          }
          return jsonResponse(404, { error: "unexpected" });
        },
      }),
    ).rejects.toThrow(/invalid_grant|Photon device-token poll/);

    expect(existsSync(join(dir, "photon-device-login.json"))).toBe(false);
  });

  test("reuses a stored access token when store fails after a successful poll", async () => {
    await startPhotonConnect({
      storageDir: dir,
      isConnected: async () => false,
      now: () => 5_000,
      fetch: async () =>
        jsonResponse(200, {
          device_code: "dev-1",
          user_code: "ABCD-1234",
          verification_uri: "https://app.photon.codes/sign-in/device",
          expires_in: 600,
          interval: 5,
        }),
    });

    const stored: Record<string, string>[] = [];
    let polls = 0;
    let deviceCodes = 0;
    let storeAttempts = 0;

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/api/auth/device/code")) {
        deviceCodes += 1;
        return jsonResponse(200, {
          device_code: "dev-2",
          user_code: "WXYZ-9999",
          verification_uri: "https://app.photon.codes/sign-in/device",
          expires_in: 600,
          interval: 5,
        });
      }
      if (url.endsWith("/api/auth/device/token")) {
        polls += 1;
        return jsonResponse(200, { access_token: "tok-1" });
      }
      if (url.endsWith("/api/projects") && method === "GET") {
        return jsonResponse(200, [{ id: "proj-1", name: "Vellum Assistant" }]);
      }
      if (url.endsWith("/regenerate-secret")) {
        return jsonResponse(200, { projectSecret: "secret-rotated" });
      }
      return jsonResponse(404, { error: "unexpected" });
    };

    const store = async (values: {
      photon_project_id: string;
      photon_project_secret: string;
    }) => {
      storeAttempts += 1;
      if (storeAttempts === 1) {
        throw new Error("refusing to store an inline secret");
      }
      stored.push(values);
    };

    await expect(
      finishPhotonConnect({
        storageDir: dir,
        isConnected: async () => false,
        sleep: async () => {},
        store,
        fetch: fetchImpl,
      }),
    ).rejects.toThrow(/inline secret/);

    expect(polls).toBe(1);
    const pending = JSON.parse(
      readFileSync(join(dir, "photon-device-login.json"), "utf8"),
    ) as { accessToken?: string };
    expect(pending.accessToken).toBe("tok-1");

    const restarted = await startPhotonConnect({
      storageDir: dir,
      isConnected: async () => false,
      now: () => 5_000,
      fetch: fetchImpl,
    });
    expect(restarted).toEqual({
      alreadyConnected: false,
      alreadyApproved: true,
    });
    expect(deviceCodes).toBe(0);

    const done = await finishPhotonConnect({
      storageDir: dir,
      isConnected: async () => false,
      sleep: async () => {},
      store,
      fetch: fetchImpl,
    });

    expect(polls).toBe(1);
    expect(done).toEqual({
      alreadyConnected: false,
      projectId: "proj-1",
      projectName: "Vellum Assistant",
      created: false,
    });
    expect(stored).toEqual([
      {
        photon_project_id: "proj-1",
        photon_project_secret: "secret-rotated",
      },
    ]);
  });
});
