/**
 * Live inbound loop.
 *
 * Provider-agnostic by construction: it takes a `MessagingProvider` and only
 * ever calls `subscribeInbound`. Photon's adapter is the one that knows the
 * stream is gRPC; this file would work for any provider that can push.
 *
 * Live is the third ingress mode, next to webhooks and polling. It exists for
 * deployments that can hold a connection to the provider but cannot offer a
 * public URL for the provider to POST to. Hermes uses this shape for Photon
 * (a long-lived gRPC subscribe, reconnect on drop, dedupe by message id). The
 * difference is only where the subscribe runs: Hermes needed a Node sidecar
 * because its gateway is Python; this plugin already speaks the SDK, so the
 * loop sits in-process on the channel the adapter already holds for send.
 *
 * A stream that ends or throws is not a shutdown. The loop reconnects with
 * backoff, the same way the poll worker does, so a dropped connection recovers
 * without a daemon restart. `stop` is what ends it.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { z } from "zod";

import type { PluginInboundEvent } from "./channel/contract.ts";
import type {
  LiveInboundSubscription,
  MessagingProvider,
} from "./providers/types.ts";

/** Consecutive reconnects cap the delay; a healthy event resets it. */
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const MAX_SEEN_IDS = 500;

const SEEN_FILENAME = "live-seen.json";

const SeenSchema = z.object({
  ids: z.array(z.string()).default([]),
});

export interface LiveIngressLogger {
  debug(obj: object, msg: string): void;
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface LiveIngressOptions {
  provider: MessagingProvider;
  logger: LiveIngressLogger;
  /** Where normalized events go. */
  sink: (event: PluginInboundEvent) => Promise<void> | void;
  /**
   * Directory for the seen-id file. Optional so a test can run the loop
   * without touching disk; production always passes the plugin storage dir.
   */
  storageDir?: string;
  /** Injectable so tests do not wait on real backoff. */
  sleep?: (ms: number) => Promise<void>;
}

export class LiveIngress {
  private running = false;
  private current: LiveInboundSubscription | undefined;
  private backoffMs = INITIAL_BACKOFF_MS;
  private sleepTimer: ReturnType<typeof setTimeout> | undefined;
  private wakeup: (() => void) | undefined;
  private seen: Set<string>;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: LiveIngressOptions) {
    this.sleep = opts.sleep ?? ((ms) => this.timedSleep(ms));
    this.seen = new Set(readSeenIds(opts.storageDir));
  }

  /**
   * Begin the subscribe/reconnect loop.
   *
   * Safe to call twice: a second start is a no-op while one is running.
   */
  start(): void {
    if (this.running) {
      return;
    }
    if (!this.opts.provider.supportsLive || !this.opts.provider.subscribeInbound) {
      throw new Error(
        `provider ${this.opts.provider.id} does not support live ingress`,
      );
    }
    this.running = true;
    void this.loop();
  }

  /**
   * Stop the loop and close the current stream.
   *
   * Awaited on plugin shutdown so Photon's gRPC subscribe is released before
   * the provider's channel is closed. Safe when not running.
   */
  async stop(): Promise<void> {
    this.running = false;
    if (this.sleepTimer) {
      clearTimeout(this.sleepTimer);
      this.sleepTimer = undefined;
    }
    this.wakeup?.();
    this.wakeup = undefined;
    const current = this.current;
    this.current = undefined;
    await current?.close();
    // The loop exits on the next `running` check once the iterator
    // completes. Do not wait on `loopDone` here: a subscribe that ignores
    // `close()` would otherwise hang plugin disable.
  }

  private async loop(): Promise<void> {
    while (this.running) {
      const readiness = await this.opts.provider.checkReadiness();
      if (!this.running) {
        return;
      }
      if (!readiness.ready) {
        this.opts.logger.warn(
          { provider: this.opts.provider.id, reason: readiness.reason },
          "imessage: live ingress is waiting until the provider is ready",
        );
        await this.backoff();
        continue;
      }

      try {
        const subscribe = this.opts.provider.subscribeInbound;
        if (!subscribe) {
          return;
        }
        const subscription = subscribe.call(this.opts.provider);
        this.current = subscription;
        for await (const record of subscription) {
          if (!this.running) {
            return;
          }
          this.backoffMs = INITIAL_BACKOFF_MS;
          if (this.seen.has(record.id)) {
            continue;
          }
          this.remember(record.id);
          if (!record.event) {
            continue;
          }
          await this.opts.sink(record.event);
        }
        if (!this.running) {
          return;
        }
        this.opts.logger.warn(
          { provider: this.opts.provider.id },
          "imessage: live stream ended, reconnecting",
        );
      } catch (err) {
        if (!this.running) {
          return;
        }
        this.opts.logger.warn(
          { err, provider: this.opts.provider.id },
          "imessage: live stream failed, reconnecting",
        );
      } finally {
        this.current = undefined;
      }

      await this.backoff();
    }
  }

  private remember(id: string): void {
    this.seen.add(id);
    if (this.seen.size > MAX_SEEN_IDS) {
      const ids = [...this.seen];
      this.seen = new Set(ids.slice(ids.length - MAX_SEEN_IDS));
    }
    writeSeenIds(this.opts.storageDir, [...this.seen]);
  }

  private async backoff(): Promise<void> {
    if (!this.running) {
      return;
    }
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    await Promise.race([
      this.sleep(delay),
      new Promise<void>((resolve) => {
        this.wakeup = resolve;
      }),
    ]);
    this.wakeup = undefined;
  }

  private timedSleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.wakeup = resolve;
      this.sleepTimer = setTimeout(() => {
        this.sleepTimer = undefined;
        this.wakeup = undefined;
        resolve();
      }, ms);
    });
  }
}

function seenPath(storageDir: string): string {
  return join(storageDir, SEEN_FILENAME);
}

function readSeenIds(storageDir: string | undefined): string[] {
  if (!storageDir) {
    return [];
  }
  const path = seenPath(storageDir);
  if (!existsSync(path)) {
    return [];
  }
  try {
    const parsed = SeenSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data.ids : [];
  } catch {
    return [];
  }
}

function writeSeenIds(storageDir: string | undefined, ids: string[]): void {
  if (!storageDir) {
    return;
  }
  const path = seenPath(storageDir);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ids }, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}
