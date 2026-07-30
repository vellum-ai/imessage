/**
 * Inbound delivery: admitted message to agent loop to reply.
 *
 * One entry point shared by both ingress modes, so the poll worker's sink and
 * the webhook route cannot diverge on who gets in or how a reply goes out.
 *
 * ## What this bypasses
 *
 * `runConversationTurn` runs the agent loop directly. It takes no actor, no
 * trust class, and no channel, so nothing here goes through the gateway's
 * `no_one` kill switch, trust classification, or admission floor. That is the
 * whole reason `admitSender` exists and why it only admits an existing contact
 * in good standing. When the host's channel pipeline accepts plugin-supplied
 * inbound, this file collapses into a call to it and `admit.ts` goes away.
 */

import { runConversationTurn } from "@vellumai/plugin-api";
import type { ContentBlock } from "@vellumai/plugin-api";

import { admitSender } from "./channel/admit.ts";
import type { PluginInboundEvent } from "./channel/contract.ts";
import type { IMessageConfig } from "./config.ts";
import { isAllowedHandle } from "./config.ts";
import { bindConversation, getBoundConversation } from "./conversation-map.ts";

export interface InboundLogger {
  debug(obj: object, msg: string): void;
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface DeliverInboundOptions {
  event: PluginInboundEvent;
  config: IMessageConfig;
  storageDir: string;
  logger: InboundLogger;
  /** Sends the assistant's reply back over the channel. */
  reply: (conversationExternalId: string, text: string) => Promise<void>;
  /** Injectable for tests. */
  runTurn?: typeof runConversationTurn;
  admit?: typeof admitSender;
}

export type DeliverOutcome =
  | { delivered: true; conversationId: string }
  | { delivered: false; reason: string };

/**
 * Run one inbound message through admission and the agent loop.
 *
 * A refusal is silent to the sender. Replying "you are not a contact" to an
 * unknown number confirms the line is live and answers a stranger, which is
 * what an unadmitted sender must not get.
 */
export async function deliverInbound(
  opts: DeliverInboundOptions,
): Promise<DeliverOutcome> {
  const { event, config, storageDir, logger } = opts;
  const actor = event.actor.actorExternalId;
  const externalId = event.message.conversationExternalId;

  // The config allowlist narrows further when set. It is not the gate — the
  // contact check below is — but a line shared with something else can use it
  // to keep that traffic out entirely.
  if (!isAllowedHandle(config, actor)) {
    logger.debug({ actor }, "imessage: sender outside the configured allowlist");
    return { delivered: false, reason: "outside allowedHandles" };
  }

  const decision = await (opts.admit ?? admitSender)({
    actorExternalId: actor,
  });
  if (!decision.admit) {
    logger.info(
      { actor, reason: decision.reason },
      "imessage: inbound refused",
    );
    return { delivered: false, reason: decision.reason };
  }

  const runTurn = opts.runTurn ?? runConversationTurn;
  const bound = getBoundConversation(storageDir, externalId);

  let result;
  try {
    result = await runTurn({
      conversationId: bound,
      content: [{ type: "text", text: event.message.content }],
    });
  } catch (err) {
    logger.error({ err, actor }, "imessage: agent turn failed");
    return {
      delivered: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  // Bind after the first successful turn, not before: binding an id for a turn
  // that then failed would strand the thread on a conversation that holds no
  // messages.
  if (!bound) {
    bindConversation(storageDir, externalId, result.conversationId);
  }

  const text = extractText(result.content);
  if (text) {
    try {
      await opts.reply(externalId, text);
    } catch (err) {
      // The turn happened and is persisted; only delivery failed. Report it
      // rather than retrying the turn, which would double-answer.
      logger.error({ err, actor }, "imessage: reply delivery failed");
      return {
        delivered: false,
        reason: `turn ran but reply failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  } else {
    logger.info(
      { actor, conversationId: result.conversationId },
      "imessage: turn produced no text to send",
    );
  }

  return { delivered: true, conversationId: result.conversationId };
}

/**
 * Flatten the assistant's content blocks into sendable text.
 *
 * Only `text` blocks. Tool calls, thinking, and tool results are the loop's
 * internals — forwarding them to a phone would leak reasoning and clutter the
 * thread.
 */
export function extractText(content: ContentBlock[]): string {
  return content
    .filter(
      (block): block is Extract<ContentBlock, { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => block.text)
    .join("\n\n")
    .trim();
}
