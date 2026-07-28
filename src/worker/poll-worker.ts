/**
 * Poll worker entry point.
 *
 * Runs as its own OS process, spawned by `supervisor.ts`. Polling lives out
 * here rather than in the daemon for the same reason meeting-bot's realtime
 * receiver does: a busy line, a slow provider, or a burst of messages must not
 * compete with the assistant's event loop, and a crash in the loop must not
 * take the daemon with it.
 *
 * Reads its bootstrap config from argv, writes NDJSON events to stdout.
 */

import { Poller } from "../poller.ts";
import { resolveProvider } from "../providers/index.ts";
import { IMessageConfigSchema, isAllowedHandle } from "../config.ts";
import type { WorkerBootstrap, WorkerMessage } from "./protocol.ts";
import { encodeWorkerMessage, WorkerBootstrapSchema } from "./protocol.ts";

function emit(message: WorkerMessage): void {
  process.stdout.write(encodeWorkerMessage(message));
}

function log(
  level: "debug" | "info" | "warn" | "error",
  msg: string,
  data?: unknown,
): void {
  emit({ type: "log", level, msg, data });
}

/** Logger shim so the poller's logging lands on the supervisor's logger. */
const workerLogger = {
  debug: (obj: object, msg: string) => log("debug", msg, obj),
  info: (obj: object, msg: string) => log("info", msg, obj),
  warn: (obj: object, msg: string) => log("warn", msg, obj),
  error: (obj: object, msg: string) => log("error", msg, obj),
};

export async function runWorker(bootstrap: WorkerBootstrap): Promise<Poller> {
  // Reconstruct the full config from the bootstrap subset so the allowlist
  // helper and the provider registry see the same shape they do in-process.
  const config = IMessageConfigSchema.parse({
    provider: bootstrap.provider,
    ingressMode: "poll",
    pollIntervalMs: bootstrap.intervalMs,
    sendChannel: bootstrap.sendChannel,
    allowedHandles: bootstrap.allowedHandles,
  });

  const provider = resolveProvider({ config });

  const readiness = await provider.checkReadiness();
  if (!readiness.ready) {
    // Exit rather than spin: the supervisor backs off and retries, which is
    // the right cadence for "not set up yet" and for "provider is down".
    emit({ type: "fatal", error: readiness.reason });
    throw new Error(readiness.reason);
  }

  const poller = new Poller({
    provider,
    storageDir: bootstrap.storageDir,
    intervalMs: bootstrap.intervalMs,
    logger: workerLogger,
    isAllowed: (handle) => isAllowedHandle(config, handle),
    sink: (event) => emit({ type: "event", event }),
  });

  poller.start();
  emit({ type: "ready" });
  return poller;
}

/** Read the bootstrap blob passed as the single argv entry. */
export function parseBootstrapArg(raw: string | undefined): WorkerBootstrap {
  if (!raw) throw new Error("poll worker started without a bootstrap argument");
  return WorkerBootstrapSchema.parse(JSON.parse(raw));
}

// Only run when executed directly, so the module stays importable by tests.
if (import.meta.main) {
  const bootstrap = parseBootstrapArg(process.argv[2]);
  const poller = await runWorker(bootstrap);

  const stop = () => {
    poller.stop();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
