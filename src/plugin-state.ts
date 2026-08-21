/**
 * In-process handles the hooks, routes, and runtime share.
 *
 * `init` stashes the context and the resolved config; the provider route
 * reaches the runtime to restart ingress live; `shutdown` stops the worker.
 *
 * The webhook route does not treat this module as the source of config. The
 * host loads routes with a cache-busting query string, which is a different
 * instance of this file than the one `init` populated. Config that a delivery
 * must see lives in `config.json` and is read from disk.
 *
 * Nothing else durable lives here. The poll cursor and live seen-ids belong
 * to `cursor.ts` and `live-ingress.ts`.
 */

import type { PluginChannelProvider } from "./channel/contract.ts";
import type { IMessageConfig } from "./config.ts";
import type { LiveIngress } from "./live-ingress.ts";
import type { MessagingProvider } from "./providers/types.ts";
import type { PollWorkerSupervisor } from "./worker/supervisor.ts";

/**
 * The bits of `InitContext` the runtime needs after `init` returns.
 *
 * Narrowed to a local shape rather than storing the whole context: it makes
 * what the runtime actually depends on explicit, and lets tests drive the
 * runtime without constructing a full host context.
 */
export interface RuntimeContext {
  logger: {
    debug(obj: object, msg: string): void;
    info(obj: object, msg: string): void;
    warn(obj: object, msg: string): void;
    error(obj: object, msg: string): void;
  };
  pluginStorageDir: string;
  pluginName: string;
}

/**
 * What happened the last time this process tried to register a webhook.
 *
 * Kept because registration runs un-awaited on a start and reported itself
 * only through the logger, which leaves "no webhook exists and nothing says
 * why" as a reachable state — and it was reached. The settings route reports
 * this, so the answer survives a logger that is not being captured.
 *
 * In memory on purpose: it describes this process's attempt, and a stale
 * record read from disk after a restart would be worse than none.
 */
/**
 * How far registration got before it stopped.
 *
 * These fail for entirely unrelated reasons — a credential store that is down,
 * an assistant with no public URL, a provider refusing the request, a write
 * that did not land — and the remedies have nothing in common. Naming the step
 * is what lets a reader skip straight to the right one instead of re-checking
 * all four.
 */
export type WebhookRegistrationStep =
  | "read-secret"
  | "resolve-url"
  | "call-provider"
  | "store-secret";

export interface WebhookRegistrationReport {
  provider: string;
  outcome: "registered" | "already-registered" | "skipped" | "failed";
  /** Where the provider was pointed, when one was resolved. */
  url?: string;
  /** How far it got. Absent on reports written before this was recorded. */
  step?: WebhookRegistrationStep;
  /**
   * Why it was skipped or how it failed, as `describeError` renders it — the
   * cause chain and the status included, not just the outermost message.
   */
  reason?: string;
  at: string;
}

/**
 * The last delivery probe this process saw.
 *
 * A vendor's own test — Comms' `comms.ping` — travels the real pipeline, so
 * one arriving is proof that registration, the signing secret, the gateway
 * route and this handler all work. That is the only confirmation available
 * without waiting for a human to text in, and it used to be discarded as "not
 * an inbound message", which reads exactly like the failure it disproves.
 *
 * In memory for the same reason the registration report is: it describes this
 * process, and a stale record read after a restart would be worse than none.
 */
export interface InboundProbeReport {
  provider: string;
  /** The vendor's own name for the event, e.g. `comms.ping`. */
  label: string;
  at: string;
}

interface PluginState {
  ctx?: RuntimeContext;
  config?: IMessageConfig;
  provider?: MessagingProvider;
  channel?: PluginChannelProvider;
  supervisor?: PollWorkerSupervisor;
  liveIngress?: LiveIngress;
  webhook?: WebhookRegistrationReport;
  probe?: InboundProbeReport;
}

const state: PluginState = {};

export function setInitContext(ctx: RuntimeContext): void {
  state.ctx = ctx;
}

export function getInitContext(): RuntimeContext | undefined {
  return state.ctx;
}

export function setConfig(config: IMessageConfig): void {
  state.config = config;
}

export function getConfig(): IMessageConfig | undefined {
  return state.config;
}

export function setProvider(provider: MessagingProvider | undefined): void {
  state.provider = provider;
}

export function getProvider(): MessagingProvider | undefined {
  return state.provider;
}

export function setChannel(channel: PluginChannelProvider | undefined): void {
  state.channel = channel;
}

export function getChannel(): PluginChannelProvider | undefined {
  return state.channel;
}

export function setSupervisor(
  supervisor: PollWorkerSupervisor | undefined,
): void {
  state.supervisor = supervisor;
}

export function getSupervisor(): PollWorkerSupervisor | undefined {
  return state.supervisor;
}

export function setLiveIngress(ingress: LiveIngress | undefined): void {
  state.liveIngress = ingress;
}

export function getLiveIngress(): LiveIngress | undefined {
  return state.liveIngress;
}

export function setWebhookReport(report: WebhookRegistrationReport): void {
  state.webhook = report;
}

/** Record a delivery probe. Stamped here so the route cannot forget the time. */
export function recordInboundProbe(probe: {
  provider: string;
  label: string;
}): void {
  state.probe = { ...probe, at: new Date().toISOString() };
}

export function getInboundProbe(): InboundProbeReport | undefined {
  return state.probe;
}

export function getWebhookReport(): WebhookRegistrationReport | undefined {
  return state.webhook;
}

/** Clear everything. Used by `shutdown` and by tests. */
export function resetPluginState(): void {
  state.ctx = undefined;
  state.config = undefined;
  state.provider = undefined;
  state.channel = undefined;
  state.supervisor = undefined;
  state.liveIngress = undefined;
  state.webhook = undefined;
  state.probe = undefined;
}
