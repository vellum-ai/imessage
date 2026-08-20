/**
 * Connect a Photon project through the dashboard device flow.
 *
 * Two steps so the assistant can show the approval URL before it starts
 * waiting: `startPhotonConnect` mints a device code and writes it under
 * `data/`, `finishPhotonConnect` polls until the user approves, then finds
 * or creates a project, rotates its secret, and stores the pair the rest of
 * the plugin already reads (`imessage/photon_project_id` and
 * `imessage/photon_project_secret`).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { z } from "zod";

import { storeCredentials } from "../../app-credentials.ts";
import { pluginDataDir } from "../../plugin-paths.ts";
import { PhotonClient } from "./client.ts";
import {
  DEFAULT_PHOTON_PROJECT_NAME,
  PhotonDashboardClient,
  type DeviceCodeChallenge,
  type PhotonDashboardClientOptions,
} from "./dashboard.ts";

const PENDING_FILENAME = "photon-device-login.json";

const PendingSchema = z.object({
  deviceCode: z.string().min(1),
  userCode: z.string().min(1),
  verificationUri: z.string().min(1),
  verificationUriComplete: z.string().min(1).optional(),
  expiresAt: z.number().int().positive(),
  interval: z.number().int().positive(),
});

export type PendingPhotonConnect = z.infer<typeof PendingSchema>;

export interface PhotonConnectStart {
  alreadyConnected: boolean;
  userCode?: string;
  verificationUri?: string;
  verificationUriComplete?: string;
  expiresIn?: number;
}

export interface PhotonConnectFinish {
  alreadyConnected: boolean;
  projectId?: string;
  projectName?: string;
  created?: boolean;
}

export interface PhotonConnectOptions extends PhotonDashboardClientOptions {
  storageDir?: string;
  projectName?: string;
  force?: boolean;
  /** Test seam. Production asks the Spectrum client whether the stored pair works. */
  isConnected?: () => Promise<boolean>;
  /** Test seam. Production writes through `assistant credentials set`. */
  store?: (values: {
    photon_project_id: string;
    photon_project_secret: string;
  }) => Promise<void>;
}

function pendingPath(storageDir: string): string {
  return join(storageDir, PENDING_FILENAME);
}

function writePending(
  storageDir: string,
  challenge: DeviceCodeChallenge,
  now: () => number,
): void {
  const path = pendingPath(storageDir);
  mkdirSync(dirname(path), { recursive: true });
  const pending: PendingPhotonConnect = {
    deviceCode: challenge.deviceCode,
    userCode: challenge.userCode,
    verificationUri: challenge.verificationUri,
    ...(challenge.verificationUriComplete
      ? { verificationUriComplete: challenge.verificationUriComplete }
      : {}),
    expiresAt: now() + challenge.expiresIn * 1000,
    interval: challenge.interval,
  };
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(pending, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

function readPending(storageDir: string): PendingPhotonConnect {
  const path = pendingPath(storageDir);
  if (!existsSync(path)) {
    throw new Error(
      "No Photon login is in progress. Run connect.ts --start first and open the approval URL.",
    );
  }
  const parsed = PendingSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) {
    throw new Error(
      "The in-progress Photon login file is unreadable. Run connect.ts --start again.",
    );
  }
  return parsed.data;
}

function clearPending(storageDir: string): void {
  const path = pendingPath(storageDir);
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

async function photonAlreadyConnected(): Promise<boolean> {
  try {
    await new PhotonClient().getProject();
    return true;
  } catch {
    return false;
  }
}

function dashboardOf(opts: PhotonConnectOptions): PhotonDashboardClient {
  return new PhotonDashboardClient({
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.sleep ? { sleep: opts.sleep } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
    ...(opts.clientId ? { clientId: opts.clientId } : {}),
  });
}

/**
 * Mint a device code and persist it so `--finish` can poll later.
 *
 * A working stored pair is treated as already connected unless `force` is
 * set. Reconnecting rotates the project secret.
 */
export async function startPhotonConnect(
  opts: PhotonConnectOptions = {},
): Promise<PhotonConnectStart> {
  const storageDir = opts.storageDir ?? pluginDataDir();
  const isConnected = opts.isConnected ?? photonAlreadyConnected;
  if (!opts.force && (await isConnected())) {
    return { alreadyConnected: true };
  }

  const now = opts.now ?? Date.now;
  const challenge = await dashboardOf(opts).requestDeviceCode();
  writePending(storageDir, challenge, now);
  return {
    alreadyConnected: false,
    userCode: challenge.userCode,
    verificationUri: challenge.verificationUri,
    ...(challenge.verificationUriComplete
      ? { verificationUriComplete: challenge.verificationUriComplete }
      : {}),
    expiresIn: challenge.expiresIn,
  };
}

/**
 * Finish a started login: poll, provision a project, store the secret pair.
 */
export async function finishPhotonConnect(
  opts: PhotonConnectOptions = {},
): Promise<PhotonConnectFinish> {
  const storageDir = opts.storageDir ?? pluginDataDir();
  const isConnected = opts.isConnected ?? photonAlreadyConnected;
  if (!opts.force && (await isConnected())) {
    clearPending(storageDir);
    return { alreadyConnected: true };
  }

  const pending = readPending(storageDir);
  const now = opts.now ?? Date.now;
  const remainingSec = Math.max(1, Math.floor((pending.expiresAt - now()) / 1000));
  const dashboard = dashboardOf(opts);
  const token = await dashboard.pollForToken({
    deviceCode: pending.deviceCode,
    userCode: pending.userCode,
    verificationUri: pending.verificationUri,
    ...(pending.verificationUriComplete
      ? { verificationUriComplete: pending.verificationUriComplete }
      : {}),
    expiresIn: remainingSec,
    interval: pending.interval,
  });
  const projectName = opts.projectName ?? DEFAULT_PHOTON_PROJECT_NAME;
  const existing = await dashboard.findProjectByName(token, projectName);
  const project =
    existing ?? (await dashboard.createProject(token, projectName));
  const secret = await dashboard.regenerateProjectSecret(token, project.id);
  const store =
    opts.store ??
    ((values: {
      photon_project_id: string;
      photon_project_secret: string;
    }) => storeCredentials("photon", values));
  await store({
    photon_project_id: project.id,
    photon_project_secret: secret,
  });
  clearPending(storageDir);
  return {
    alreadyConnected: false,
    projectId: project.id,
    projectName: project.name ?? projectName,
    created: existing === undefined,
  };
}

/** Approval URL the user should open. Prefers the complete URI when Photon sent one. */
export function photonApprovalUrl(started: PhotonConnectStart): string | undefined {
  return started.verificationUriComplete ?? started.verificationUri;
}
