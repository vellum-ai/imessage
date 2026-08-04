/**
 * Credential surface tests.
 *
 * `execFile` is mocked at the module level, so nothing here shells out. That
 * is not only about speed: the real `assistant credentials set` would write
 * into whatever credential store the machine running the tests has, and a test
 * suite must not leave a credential behind on a developer's box.
 *
 * `resolveCredential` is mocked the same way the provider tests do it, which
 * is what lets these drive "already stored" and "not stored yet" without a
 * host.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const realPluginApi = await import("@vellumai/plugin-api");
const realChildProcess = await import("node:child_process");

interface ExecCall {
  file: string;
  args: string[];
}

let execCalls: ExecCall[] = [];
let execFails: string | null = null;
/** Credential fields the fake store already holds. */
let stored = new Set<string>();

mock.module("@vellumai/plugin-api", () => ({
  ...realPluginApi,
  resolveCredential: mock(async (ref: string) => {
    const field = ref.split("/")[1] ?? "";
    if (!stored.has(field)) throw new Error("credential not found");
    return "stored-value";
  }),
}));

mock.module("node:child_process", () => ({
  ...realChildProcess,
  execFile: (
    file: string,
    args: string[],
    _opts: unknown,
    callback: (err: Error | null, stdout: string, stderr: string) => void,
  ) => {
    execCalls.push({ file, args });
    if (execFails) {
      const err = Object.assign(new Error("Command failed"), {
        stderr: execFails,
      });
      callback(err, "", execFails);
      return;
    }
    callback(null, "", "");
  },
}));

const { readCredentialStatus, storeCredentials, CredentialWriteError } =
  await import("../app-credentials.ts");

beforeEach(() => {
  execCalls = [];
  execFails = null;
  stored = new Set();
});

afterEach(() => {
  stored = new Set();
});

describe("readCredentialStatus", () => {
  test("reports every provider's fields, not just the configured one", async () => {
    // The app renders the picker before anything is chosen, so it needs the
    // other provider's state without a second round trip.
    const status = await readCredentialStatus();

    expect(Object.keys(status).sort()).toEqual(["comms", "photon"]);
    expect(status.comms?.map((f) => f.field)).toEqual(["api_key"]);
    expect(status.photon?.map((f) => f.field)).toEqual([
      "photon_project_id",
      "photon_project_secret",
    ]);
  });

  test("marks stored fields set and leaves the rest unset", async () => {
    stored.add("photon_project_id");
    const status = await readCredentialStatus();

    const photon = status.photon ?? [];
    expect(photon.find((f) => f.field === "photon_project_id")?.set).toBe(true);
    expect(photon.find((f) => f.field === "photon_project_secret")?.set).toBe(
      false,
    );
  });

  test("never carries a stored value", async () => {
    // The app has no use for one, and a route that returns a secret exists
    // only to be called by something that is not this app.
    stored.add("api_key");
    const status = await readCredentialStatus();

    expect(JSON.stringify(status)).not.toContain("stored-value");
  });

  test("a field is only set when it resolves to something", async () => {
    const status = await readCredentialStatus();
    expect(status.comms?.[0]?.set).toBe(false);
  });
});

describe("storeCredentials", () => {
  test("writes through the CLI without a shell", async () => {
    await storeCredentials("comms", { api_key: "sk-live-1" });

    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]?.file).toBe("assistant");
    expect(execCalls[0]?.args).toEqual([
      "credentials",
      "set",
      "--service",
      "imessage",
      "--field",
      "api_key",
      "sk-live-1",
    ]);
  });

  test("writes each of a provider's fields", async () => {
    await storeCredentials("photon", {
      photon_project_id: "proj_1",
      photon_project_secret: "shh",
    });

    expect(execCalls.map((c) => c.args[5])).toEqual([
      "photon_project_id",
      "photon_project_secret",
    ]);
  });

  test("trims surrounding whitespace off a pasted value", async () => {
    // A key copied out of a dashboard arrives with a trailing newline more
    // often than not, and a credential that fails auth by one character is
    // miserable to diagnose.
    await storeCredentials("comms", { api_key: "  sk-live-2\n" });
    expect(execCalls[0]?.args[6]).toBe("sk-live-2");
  });

  test("rejects a field the provider does not have", async () => {
    // The credential service is shared across providers, so a typo would
    // otherwise store a value nothing ever reads and report success.
    await expect(
      storeCredentials("comms", { photon_project_id: "proj_1" }),
    ).rejects.toBeInstanceOf(CredentialWriteError);
    expect(execCalls).toHaveLength(0);
  });

  test("rejects an empty value rather than storing one", async () => {
    // "Saved" has to mean the field now resolves.
    await expect(
      storeCredentials("photon", { photon_project_secret: "   " }),
    ).rejects.toThrow(/cannot be empty/);
    expect(execCalls).toHaveLength(0);
  });

  test("validates every field before writing any of them", async () => {
    // A half-applied write would leave the pair mismatched, which reads as
    // bad credentials rather than as a rejected edit.
    await expect(
      storeCredentials("photon", {
        photon_project_id: "proj_1",
        nonsense: "x",
      }),
    ).rejects.toThrow(/no credential field/);
    expect(execCalls).toHaveLength(0);
  });

  test("rejects an empty submission", async () => {
    await expect(storeCredentials("comms", {})).rejects.toThrow(/no credential/);
  });

  test("a CLI failure names the field and quotes the reason", async () => {
    // "command failed with exit code 1" does not say which of two Photon
    // fields did not take.
    execFails = "unknown option --field";

    await expect(
      storeCredentials("photon", { photon_project_id: "proj_1" }),
    ).rejects.toThrow(/imessage:photon_project_id.*unknown option/s);
  });
});
