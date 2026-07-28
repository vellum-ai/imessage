/**
 * Poll worker supervisor.
 *
 * Owns the worker subprocess: spawn, read its NDJSON stdout, restart it with
 * backoff when it dies, and stop it on shutdown.
 *
 * The restart policy is the point. A worker that exits because the line is not
 * set up yet, or because the provider is down, should be retried on a slowing
 * cadence rather than hammered — and a worker that dies mid-poll should come
 * back without a daemon restart.
 */

import { join } from "node:path";

import type { PluginInboundEvent } from "../channel/contract.ts";
import type { WorkerBootstrap } from "./protocol.ts";
import { parseWorkerLine } from "./protocol.ts";

/** Backoff schedule between restarts. Caps rather than growing without bound. */
const RESTART_DELAYS_MS = [1_000, 5_000, 15_000, 60_000];

export interface SupervisorLogger {
  debug(obj: object, msg: string): void;
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface SupervisorOptions {
  bootstrap: WorkerBootstrap;
  logger: SupervisorLogger;
  sink: (event: PluginInboundEvent) => Promise<void> | void;
  /** Injectable for tests. Defaults to spawning the real worker. */
  spawn?: (args: string[]) => WorkerHandle;
}

/** The subset of a spawned process the supervisor uses. */
export interface WorkerHandle {
  readonly stdout: ReadableStream<Uint8Array> | null;
  readonly exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): void;
}

export class PollWorkerSupervisor {
  private handle: WorkerHandle | undefined;
  private stopped = false;
  private restarts = 0;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly opts: SupervisorOptions) {}

  start(): void {
    if (this.stopped) return;
    this.spawnOnce();
  }

  /**
   * Stop the worker and cancel any pending restart.
   *
   * Idempotent: shutdown can fire after a crash has already scheduled a
   * restart, and both paths have to converge on "no process, no timer".
   */
  stop(): void {
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    this.handle?.kill();
    this.handle = undefined;
  }

  private spawnOnce(): void {
    const workerPath = join(import.meta.dir, "poll-worker.ts");
    const args = [workerPath, JSON.stringify(this.opts.bootstrap)];

    const handle = this.opts.spawn
      ? this.opts.spawn(args)
      : (Bun.spawn(["bun", ...args], {
          stdout: "pipe",
          stderr: "inherit",
        }) as unknown as WorkerHandle);

    this.handle = handle;

    void this.readStdout(handle);
    void handle.exited.then((code) => this.onExit(code));
  }

  private async readStdout(handle: WorkerHandle): Promise<void> {
    if (!handle.stdout) return;
    const decoder = new TextDecoder();
    let buffer = "";

    for await (const chunk of handle.stdout as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      // Keep the trailing partial line in the buffer; a split mid-JSON is
      // normal on a pipe and must not be parsed as a whole message.
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        await this.handleLine(line);
      }
    }
  }

  private async handleLine(line: string): Promise<void> {
    const message = parseWorkerLine(line);
    if (!message) return;

    switch (message.type) {
      case "ready":
        // A worker that got as far as polling is healthy, so the backoff
        // resets here rather than on spawn: a process that crashes during
        // startup every time should keep backing off.
        this.restarts = 0;
        this.opts.logger.info({}, "imessage: poll worker ready");
        return;
      case "event":
        await this.opts.sink(message.event);
        return;
      case "log":
        this.opts.logger[message.level](
          { data: message.data },
          `imessage worker: ${message.msg}`,
        );
        return;
      case "fatal":
        this.opts.logger.warn(
          { error: message.error },
          "imessage: poll worker cannot start",
        );
        return;
    }
  }

  private onExit(code: number): void {
    if (this.stopped) return;
    this.handle = undefined;

    const delay =
      RESTART_DELAYS_MS[Math.min(this.restarts, RESTART_DELAYS_MS.length - 1)] ??
      RESTART_DELAYS_MS[RESTART_DELAYS_MS.length - 1]!;
    this.restarts++;

    this.opts.logger.warn(
      { code, delayMs: delay, restarts: this.restarts },
      "imessage: poll worker exited, restarting",
    );

    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (!this.stopped) this.spawnOnce();
    }, delay);
  }
}
