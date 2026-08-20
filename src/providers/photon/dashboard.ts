/**
 * Photon Dashboard API: device login and project credentials.
 *
 * The Spectrum control plane (`spectrum.photon.codes`) authenticates with
 * HTTP Basic `projectId:projectSecret`. Those two values are what the rest of
 * this plugin stores and uses. The only way to mint them without pasting from
 * the dashboard is Photon's RFC 8628 device flow on the Dashboard API
 * (`app.photon.codes`), the same path the Photon CLI and Hermes use.
 *
 * A device-flow token is a user session, not a project secret. This client
 * uses it only long enough to find or create a project and read a secret,
 * then the token is dropped. Photon's dashboard shows a project secret once;
 * `regenerate-secret` is the documented way to read one afterwards.
 *
 * Hosted Photon allowlists device clients. An unregistered `client_id` is
 * `400 {"error":"invalid_client"}`, so this uses Photon's published CLI
 * client (`photon-cli`) until a dedicated id exists.
 */

import { describeApiFailure, describeError } from "../error-detail.ts";

export const PHOTON_DASHBOARD_BASE = "https://app.photon.codes";
export const PHOTON_DEVICE_CLIENT_ID = "photon-cli";
export const PHOTON_DEVICE_SCOPE = "openid profile email";
export const DEFAULT_PHOTON_PROJECT_NAME = "Vellum Assistant";

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const DEFAULT_POLL_INTERVAL_SEC = 5;
const DEFAULT_EXPIRES_IN_SEC = 1_800;
const REQUEST_TIMEOUT_MS = 30_000;

export class PhotonDashboardError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
    this.name = "PhotonDashboardError";
  }
}

export interface DeviceCodeChallenge {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
}

export interface DashboardProject {
  id: string;
  name?: string;
}

export interface PhotonDashboardClientOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  baseUrl?: string;
  clientId?: string;
}

export class PhotonDashboardClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly baseUrl: string;
  private readonly clientId: string;

  constructor(opts: PhotonDashboardClientOptions = {}) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = opts.now ?? Date.now;
    this.baseUrl = (opts.baseUrl ?? PHOTON_DASHBOARD_BASE).replace(/\/$/, "");
    this.clientId = opts.clientId ?? PHOTON_DEVICE_CLIENT_ID;
  }

  /** `POST /api/auth/device/code` */
  async requestDeviceCode(): Promise<DeviceCodeChallenge> {
    const raw = await this.request("POST", "/api/auth/device/code", {
      body: {
        client_id: this.clientId,
        scope: PHOTON_DEVICE_SCOPE,
      },
    });
    const data = asRecord(raw);
    const deviceCode = stringField(data, "device_code");
    const userCode = stringField(data, "user_code");
    const verificationUri = stringField(data, "verification_uri");
    if (!deviceCode || !userCode || !verificationUri) {
      throw new PhotonDashboardError(
        "Photon did not return a device code, user code, and verification URL",
      );
    }
    return {
      deviceCode,
      userCode,
      verificationUri,
      ...(stringField(data, "verification_uri_complete")
        ? { verificationUriComplete: stringField(data, "verification_uri_complete") }
        : {}),
      expiresIn: intField(data, "expires_in") ?? DEFAULT_EXPIRES_IN_SEC,
      interval: intField(data, "interval") ?? DEFAULT_POLL_INTERVAL_SEC,
    };
  }

  /**
   * Poll `POST /api/auth/device/token` until the user approves.
   *
   * Sleeps first, then polls, matching RFC 8628 and Photon's CLI.
   * `authorization_pending` keeps the interval, `slow_down` adds 5s, HTTP
   * 429 adds 10s. `access_denied` and `expired_token` abort.
   */
  async pollForToken(challenge: DeviceCodeChallenge): Promise<string> {
    const deadline = this.now() + challenge.expiresIn * 1000;
    let intervalSec = challenge.interval || DEFAULT_POLL_INTERVAL_SEC;

    while (this.now() < deadline) {
      await this.sleep(intervalSec * 1000);
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}/api/auth/device/token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            grant_type: DEVICE_GRANT,
            device_code: challenge.deviceCode,
            client_id: this.clientId,
          }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        throw new PhotonDashboardError(
          `Photon device-token poll could not be reached: ${describeError(err)}`,
        );
      }

      if (response.status === 200) {
        const raw = await readJson(response);
        const token = pickAccessToken(asRecord(raw), response.headers);
        if (!token) {
          throw new PhotonDashboardError(
            "Photon returned 200 but no access token in the device-token response",
          );
        }
        return token;
      }

      if (response.status === 429) {
        intervalSec += 10;
        continue;
      }

      const raw = await readJson(response).catch(() => ({}));
      const error = deviceTokenError(raw);
      if (response.status === 400 && error === "authorization_pending") {
        continue;
      }
      if (response.status === 400 && error === "slow_down") {
        intervalSec += 5;
        continue;
      }
      if (error === "expired_token" || error === "access_denied") {
        throw new PhotonDashboardError(`Photon login failed: ${error}`, response.status);
      }
      throw new PhotonDashboardError(
        describeApiFailure("Photon device-token poll", response.status, textOf(raw)),
        response.status,
      );
    }

    throw new PhotonDashboardError("Photon device login timed out");
  }

  /** `GET /api/projects` */
  async listProjects(token: string): Promise<DashboardProject[]> {
    const raw = await this.request("GET", "/api/projects", { token });
    return unwrapList(raw)
      .map((entry) => {
        const id = stringField(entry, "id");
        if (!id) {
          return undefined;
        }
        const name = stringField(entry, "name");
        return name ? { id, name } : { id };
      })
      .filter((entry): entry is DashboardProject => entry !== undefined);
  }

  /** First project whose name matches, case-insensitive. */
  async findProjectByName(
    token: string,
    name: string,
  ): Promise<DashboardProject | undefined> {
    const target = name.trim().toLowerCase();
    for (const project of await this.listProjects(token)) {
      if ((project.name ?? "").trim().toLowerCase() === target) {
        return project;
      }
    }
    return undefined;
  }

  /** `POST /api/projects` */
  async createProject(
    token: string,
    name: string,
  ): Promise<DashboardProject> {
    const raw = await this.request("POST", "/api/projects", {
      token,
      body: {
        name,
        location: "United States",
        template: false,
        observability: false,
      },
    });
    const data = asRecord(raw);
    if (data.error) {
      throw new PhotonDashboardError(
        `Photon create-project failed: ${String(data.error)}`,
      );
    }
    const id = stringField(data, "id");
    if (!id) {
      throw new PhotonDashboardError("Photon create-project did not return a project id");
    }
    return { id, name: stringField(data, "name") ?? name };
  }

  /**
   * `POST /api/projects/{id}/regenerate-secret`
   *
   * This is the only way to read a project secret after create. It rotates
   * the secret, so a reconnect replaces whatever was stored before.
   */
  async regenerateProjectSecret(token: string, projectId: string): Promise<string> {
    const raw = await this.request(
      "POST",
      `/api/projects/${encodeURIComponent(projectId)}/regenerate-secret`,
      { token, body: {} },
    );
    const data = asRecord(raw);
    if (data.error) {
      throw new PhotonDashboardError(
        `Photon regenerate-secret failed: ${String(data.error)}`,
      );
    }
    const secret =
      stringField(data, "projectSecret") ?? stringField(data, "project_secret");
    if (!secret) {
      throw new PhotonDashboardError(
        "Photon regenerate-secret returned no projectSecret",
      );
    }
    return secret;
  }

  private async request(
    method: string,
    path: string,
    opts: { token?: string; body?: unknown } = {},
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new PhotonDashboardError(
        `Photon ${method} ${path} could not be reached: ${describeError(err)}`,
      );
    }
    const raw = await readJson(response).catch(async () => await response.text());
    if (!response.ok) {
      throw new PhotonDashboardError(
        describeApiFailure(`Photon ${method} ${path}`, response.status, textOf(raw)),
        response.status,
      );
    }
    return raw;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function intField(data: Record<string, unknown>, key: string): number | undefined {
  const value = data[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function unwrapList(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) {
    return data.filter(
      (entry): entry is Record<string, unknown> =>
        typeof entry === "object" && entry !== null,
    );
  }
  const record = asRecord(data);
  for (const key of ["data", "projects", "items"]) {
    const inner = record[key];
    if (Array.isArray(inner)) {
      return unwrapList(inner);
    }
  }
  return [];
}

function pickAccessToken(
  body: Record<string, unknown>,
  headers: Headers,
): string | undefined {
  const session = asRecord(body.session);
  const nested = asRecord(body.data);
  const candidates = [
    body.access_token,
    body.accessToken,
    session.access_token,
    nested.access_token,
    nested.accessToken,
    headers.get("set-auth-token"),
  ];
  for (const value of candidates) {
    const token = cleanBearer(value);
    if (token) {
      return token;
    }
  }
  return undefined;
}

function cleanBearer(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const token = value.trim().replace(/^bearer\s+/i, "").trim();
  return token || undefined;
}

function deviceTokenError(raw: unknown): string {
  const data = asRecord(raw);
  return stringField(data, "error") ?? stringField(data, "message") ?? "";
}

async function readJson(response: Response): Promise<unknown> {
  return await response.json();
}

function textOf(raw: unknown): string | undefined {
  if (typeof raw === "string") {
    return raw;
  }
  if (raw === undefined || raw === null) {
    return undefined;
  }
  try {
    return JSON.stringify(raw);
  } catch {
    return undefined;
  }
}
