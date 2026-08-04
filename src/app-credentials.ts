/**
 * Reading and writing the credentials the settings app collects.
 *
 * Two things worth knowing before changing anything here.
 *
 * **Values only travel inward.** The app is told whether a field is set, never
 * what it is set to. There is no route that returns a stored secret, because
 * the app has no use for one: it renders an empty field over a "Saved" marker
 * and replaces the value or leaves it alone.
 *
 * **Writing goes through the CLI.** `@vellumai/plugin-api` exports
 * `resolveCredential` and nothing that stores one, so `assistant credentials
 * set` is the only way in — the same CLI the `imessage` skill's script already
 * shells out to for `reveal`. `execFile`, never `exec`, so no shell parses a
 * secret. The value does ride in argv, which is visible in the process list
 * for the moment the command runs; that is the tradeoff the host's own
 * documented command already makes, and the alternative — writing the secret
 * into `config.json` — is worse and permanent.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { resolveCredential } from "@vellumai/plugin-api";

import {
  CREDENTIAL_SERVICE,
  PROVIDER_CREDENTIALS,
  type CredentialField,
} from "./config.ts";
import { PROVIDER_IDS, type ProviderId } from "./providers/types.ts";

/** How long the CLI gets before a hung call is the answer. */
const CLI_TIMEOUT_MS = 10_000;

/** A credential field plus whether the store already has a value for it. */
export interface CredentialFieldStatus extends CredentialField {
  set: boolean;
}

/** Every provider's fields and whether each is filled in. */
export type CredentialStatus = Record<string, CredentialFieldStatus[]>;

export class CredentialWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialWriteError";
  }
}

/** Whether one field currently resolves to a non-empty value. */
async function isSet(field: string): Promise<boolean> {
  try {
    return Boolean(await resolveCredential(`${CREDENTIAL_SERVICE}/${field}`));
  } catch {
    return false;
  }
}

/**
 * What the app renders: every provider's fields, each marked set or not.
 *
 * Reported for all providers rather than just the configured one, so switching
 * the picker does not need a round trip to find out whether the other provider
 * is ready.
 */
export async function readCredentialStatus(): Promise<CredentialStatus> {
  const status: CredentialStatus = {};

  for (const provider of PROVIDER_IDS) {
    status[provider] = await Promise.all(
      PROVIDER_CREDENTIALS[provider].map(async (spec) => ({
        ...spec,
        set: await isSet(spec.field),
      })),
    );
  }

  return status;
}

/**
 * Store one or more of a provider's credential fields.
 *
 * Unknown field names are rejected rather than stored: the credential service
 * is shared across providers, and a typo would otherwise write a value nothing
 * ever reads and report success. Empty values are rejected for the same
 * reason — "saved" must mean the field now resolves.
 */
export async function storeCredentials(
  provider: ProviderId,
  values: Record<string, string>,
): Promise<void> {
  const allowed = new Map(
    PROVIDER_CREDENTIALS[provider].map((spec) => [spec.field, spec]),
  );

  const entries = Object.entries(values);
  if (entries.length === 0) {
    throw new CredentialWriteError("no credential values were supplied");
  }

  for (const [field, value] of entries) {
    if (!allowed.has(field)) {
      throw new CredentialWriteError(
        `${provider} has no credential field "${field}" (expected ${[...allowed.keys()].join(", ")})`,
      );
    }
    if (value.trim().length === 0) {
      throw new CredentialWriteError(
        `${allowed.get(field)?.label ?? field} cannot be empty`,
      );
    }
  }

  for (const [field, value] of entries) {
    await writeCredential(field, value.trim());
  }
}

/**
 * Read a stored credential, or `undefined` when there is none.
 *
 * Unlike the user-facing fields, webhook secrets are read back by this plugin:
 * a Comms token has to go into the URL it registers, and knowing whether a
 * Photon secret is held decides whether a registration can be reused.
 */
export async function readSecret(field: string): Promise<string | undefined> {
  try {
    const value = await resolveCredential(`${CREDENTIAL_SERVICE}/${field}`);
    return value || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Store a secret this plugin generated or was issued, rather than one a user
 * typed.
 *
 * Deliberately not routed through {@link storeCredentials}: that validates
 * against `PROVIDER_CREDENTIALS`, which is the settings app's field list, and
 * a webhook secret must never appear there.
 */
export async function storeSecret(
  field: string,
  value: string,
): Promise<void> {
  if (value.trim().length === 0) {
    throw new CredentialWriteError(`refusing to store an empty ${field}`);
  }
  await writeCredential(field, value.trim());
}

/**
 * One `assistant credentials set`.
 *
 * A failure is rewritten to name the field and quote the CLI's own stderr —
 * "command failed with exit code 1" tells a user nothing about which of two
 * Photon fields did not take.
 */
async function writeCredential(field: string, value: string): Promise<void> {
  try {
    // Promisified per call rather than once at module load: binding it at load
    // captures whatever `execFile` was then, which makes the behaviour depend
    // on import order — and makes a test that swaps the module out silently
    // exercise the real CLI.
    await promisify(execFile)(
      "assistant",
      [
        "credentials",
        "set",
        "--service",
        CREDENTIAL_SERVICE,
        "--field",
        field,
        value,
      ],
      { timeout: CLI_TIMEOUT_MS },
    );
  } catch (err) {
    const detail =
      err instanceof Error && "stderr" in err && typeof err.stderr === "string"
        ? err.stderr.trim()
        : err instanceof Error
          ? err.message
          : String(err);
    throw new CredentialWriteError(
      `could not store ${CREDENTIAL_SERVICE}:${field}${detail ? `: ${detail}` : ""}`,
    );
  }
}
