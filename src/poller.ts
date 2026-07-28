/**
 * Inbound polling loop — the default ingress mode.
 *
 * Polls `GET /messages` on an interval, normalizes what comes back, and hands
 * each event to a sink. This is the mode built entirely on documented
 * behavior: it needs only the `comms_read` scope and no public surface, so it
 * works in deployments where nothing can reach the gateway from outside.
 *
 * Correctness rests on `cursor.ts`: the timestamp bound alone is not enough to
 * avoid replaying or dropping messages at a poll boundary.
 */

import type { PluginInboundEvent } from "./channel/contract.ts";
import { normalizeCommsMessage } from "./channel/normalize.ts";
import type { CommsClient } from "./comms/client.ts";
import { createdAtOf, unknownMessageKeys } from "./comms/schemas.ts";
import type { Cursor } from "./cursor.ts";
import { advanceCursor, isSeen, readCursor, writeCursor } from "./cursor.ts";

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
  client: CommsClient;
  storageDir: string;
  intervalMs: number;
  logger: PollerLogger;
  /** Where normalized events go. */
  sink: (event: PluginInboundEvent) => Promise<void> | void;
  /**
   * Coarse pre-filter on the sender handle. The gateway's admission floor is
   * the real gate; this just keeps a shared line's other traffic out.
   */
  isAllowed?: (actorExternalId: string) => boolean;
  /** Injectable for tests. */
  now?: () => Date;
}

/**
 * Long-poll loop over the Messages API.
 *
 * Started in `init`, stopped in `shutdown`. One instance per plugin load.
 */
export class CommsPoller {
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
      const response = await this.opts.client.listMessages({
        since: this.cursor.since,
        direction: "inbound",
        limit: PAGE_LIMIT,
      });

      const fresh = response.messages.filter(
        (message) => !isSeen(this.cursor, message.id),
      );

      let delivered = 0;
      for (const message of fresh) {
        // Surface wire keys the schema does not model, so the UNVERIFIED
        // field-name guesses in schemas.ts can be corrected against reality.
        const unknown = unknownMessageKeys(message);
        if (unknown.length > 0) {
          this.opts.logger.debug(
            { unknownKeys: unknown },
            "imessage: Comms message carried unmodelled fields",
          );
        }

        const event = normalizeCommsMessage(message, this.now().toISOString());
        if (!event) continue;

        if (
          this.opts.isAllowed &&
          !this.opts.isAllowed(event.actor.actorExternalId)
        ) {
          this.opts.logger.debug(
            { actorExternalId: event.actor.actorExternalId },
            "imessage: dropped message from handle outside the allowlist",
          );
          continue;
        }

        await this.opts.sink(event);
        delivered++;
      }

      // Advance over the whole batch, not just what was delivered: a message
      // that normalized to nothing is still processed, and leaving it behind
      // the cursor would re-fetch it on every poll forever.
      this.cursor = advanceCursor(
        this.cursor,
        response.messages.map((message) => ({
          id: message.id,
          createdAt: createdAtOf(message),
        })),
      );
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
    // be hammered at the normal cadence. The loop keeps running so it
    // recovers on its own once the cause clears.
    const interval =
      this.consecutiveFailures >= FAILURES_BEFORE_BACKOFF
        ? this.opts.intervalMs * BACKOFF_MULTIPLIER
        : this.opts.intervalMs;

    this.schedule(interval);
  }
}
