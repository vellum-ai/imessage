/**
 * Inbound polling loop.
 *
 * Provider-agnostic by construction: it takes a `MessagingProvider` and only
 * ever calls `fetchInbound`. It never sees a Comms payload, a platform
 * payload, or any provider-shaped JSON — adapters normalize before handing a
 * record back. Adding a provider changes nothing in this file.
 *
 * Polling is the fallback ingress mode. Webhooks are the default; this exists
 * for deployments whose gateway is not reachable from the internet.
 *
 * Runs inside the poll worker process, not the daemon (see `src/worker/`).
 *
 * Correctness rests on `cursor.ts`: a timestamp bound alone is not enough to
 * avoid replaying or dropping messages at a poll boundary.
 */

import type { PluginInboundEvent } from "./channel/contract.ts";
import type { Cursor } from "./cursor.ts";
import { advanceCursor, isSeen, readCursor, writeCursor } from "./cursor.ts";
import type { MessagingProvider } from "./providers/types.ts";

/** Messages requested per poll. */
const PAGE_LIMIT = 100;

/** Consecutive failures before the loop backs off to a slower cadence. */
const FAILURES_BEFORE_BACKOFF = 3;
const BACKOFF_MULTIPLIER = 6;

export interface PollerLogger {
  debug(obj: object, msg: string): void;
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface PollerOptions {
  provider: MessagingProvider;
  storageDir: string;
  intervalMs: number;
  logger: PollerLogger;
  /**
   * Where normalized events go.
   *
   * Everything the line receives, unfiltered. Deciding who may reach the
   * assistant belongs to the host's inbound pipeline, which classifies the
   * actor against the gateway's own contact ACL — see the note in
   * `webhook-route.ts`.
   */
  sink: (event: PluginInboundEvent) => Promise<void> | void;
  /** Injectable for tests. */
  now?: () => Date;
}

export class Poller {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private inFlight = false;
  private consecutiveFailures = 0;
  private cursor: Cursor;
  private readonly now: () => Date;

  constructor(private readonly opts: PollerOptions) {
    this.now = opts.now ?? (() => new Date());
    this.cursor = readCursor(opts.storageDir);
  }

  /**
   * Begin polling.
   *
   * A first run with no stored cursor starts from now, not from the beginning
   * of the line's history: a newly installed plugin replaying months of old
   * messages as fresh turns would be worse than missing them.
   */
  start(): void {
    if (this.running) return;
    if (!this.opts.provider.supportsPolling) {
      throw new Error(
        `provider ${this.opts.provider.id} does not support polling`,
      );
    }
    this.running = true;

    if (!this.cursor.since) {
      this.cursor = { since: this.now().toISOString(), seenIds: [] };
      writeCursor(this.opts.storageDir, this.cursor);
      this.opts.logger.info(
        { since: this.cursor.since },
        "imessage: no stored cursor, polling from now",
      );
    }

    this.schedule(0);
  }

  /** Stop polling. Safe to call when not running. */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * One poll. Exposed so tests can drive the loop deterministically instead of
   * waiting on timers.
   */
  async pollOnce(): Promise<number> {
    if (this.inFlight) return 0;
    this.inFlight = true;
    try {
      const records = await this.opts.provider.fetchInbound({
        since: this.cursor.since,
        limit: PAGE_LIMIT,
      });

      let delivered = 0;
      for (const record of records) {
        if (isSeen(this.cursor, record.id)) continue;

        const event = record.event;
        if (!event) continue;

        await this.opts.sink(event);
        delivered++;
      }

      // Advance over the whole batch, not just what was delivered: a record
      // that normalized to nothing is still processed, and leaving it behind
      // the cursor would re-fetch it on every poll forever.
      this.cursor = advanceCursor(this.cursor, records);
      writeCursor(this.opts.storageDir, this.cursor);

      this.consecutiveFailures = 0;
      return delivered;
    } finally {
      this.inFlight = false;
    }
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      void this.tick();
    }, delayMs);
  }

  private async tick(): Promise<void> {
    if (!this.running) return;

    try {
      await this.pollOnce();
    } catch (err) {
      this.consecutiveFailures++;
      this.opts.logger.warn(
        { err, consecutiveFailures: this.consecutiveFailures },
        "imessage: poll failed",
      );
    }

    // A line that is down, rate-limited, or holding a revoked key should not
    // be hammered at the normal cadence. The loop keeps running so it recovers
    // on its own once the cause clears.
    const interval =
      this.consecutiveFailures >= FAILURES_BEFORE_BACKOFF
        ? this.opts.intervalMs * BACKOFF_MULTIPLIER
        : this.opts.intervalMs;

    this.schedule(interval);
  }
}
