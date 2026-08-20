#!/usr/bin/env bun
/**
 * Connect Photon by approving a device login in the browser.
 *
 *   bun skills/imessage-setup/scripts/connect.ts --start
 *   bun skills/imessage-setup/scripts/connect.ts --finish
 *
 * `--start` prints the approval URL and a short code, then exits so the
 * assistant can show them before anyone waits. `--finish` polls until the
 * user approves, then stores the project id and secret. `--force` rotates
 * an already-connected project's secret.
 *
 * Never prints a secret or a device code.
 */

import {
  finishPhotonConnect,
  photonApprovalUrl,
  startPhotonConnect,
} from "../../../src/providers/photon/connect.ts";

interface Args {
  start: boolean;
  finish: boolean;
  force: boolean;
}

function parseArgs(argv: string[]): Args {
  const flags = new Set(argv.filter((arg) => arg.startsWith("--")));
  const start = flags.has("--start");
  const finish = flags.has("--finish");
  if (start && finish) {
    throw new Error("Usage: connect.ts --start  OR  connect.ts --finish");
  }
  if (!start && !finish) {
    throw new Error("Usage: connect.ts --start  OR  connect.ts --finish");
  }
  return { start, finish, force: flags.has("--force") };
}

function printStart(started: Awaited<ReturnType<typeof startPhotonConnect>>): void {
  if (started.alreadyConnected) {
    console.log(
      "Photon is already connected. Pass --force to reconnect and rotate the project secret.",
    );
    return;
  }
  const url = photonApprovalUrl(started);
  if (!url || !started.userCode) {
    throw new Error("Photon did not return an approval URL and user code.");
  }
  console.log("Open this URL to authorize the assistant:");
  console.log("");
  console.log(url);
  console.log("");
  console.log(`Confirm the code matches: ${started.userCode}`);
  console.log("");
  console.log(
    "After you approve, run: bun skills/imessage-setup/scripts/connect.ts --finish",
  );
}

function printFinish(done: Awaited<ReturnType<typeof finishPhotonConnect>>): void {
  if (done.alreadyConnected) {
    console.log("Photon is already connected. Nothing to store.");
    return;
  }
  const name = done.projectName ?? "the Photon project";
  const created = done.created ? "Created and stored" : "Stored";
  console.log(
    `${created} credentials for Photon project "${name}". The secret is in the credential store, not printed here.`,
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.start) {
    printStart(await startPhotonConnect({ force: args.force }));
    return;
  }
  printFinish(await finishPhotonConnect({ force: args.force }));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
