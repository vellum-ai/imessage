/**
 * Turning an admitted delivery into a conversation turn, and the answer into a
 * text message.
 *
 * This is the half of the channel the gateway cannot do. By the time a
 * delivery reaches this plugin it has already been verified, parsed, deduped
 * and gated: the kill switch, the trust verdict, the identity canonicalization
 * and the verification and invite intercepts have all had their say, and the
 * admission floor has been compared against the sender's trust. Nothing that
 * could refuse this message is left, which is what makes it safe to act on one
 * the moment it arrives.
 *
 * What remains is the part only a plugin can do. The assistant has no adapter
 * that speaks to Comms or Photon, so the reply goes back out over the same
 * provider the delivery came in on, using credentials the gateway never holds.
 */

import { runConversationTurn } from "@vellumai/plugin-api";

import { CHANNEL_ID } from "./plugin-paths.ts";
import type { PluginInboundEvent } from "./channel/contract.ts";
import type { MessagingProvider } from "./providers/types.ts";

/**
 * The chat a turn belongs to, in the channel's own terms.
 *
 * Declared here rather than imported because `@vellumai/plugin-api` does not
 * export it yet: `runConversationTurn`'s channel binding is merged into the
 * host but unpublished, so the installed types still describe the older
 * signature. Delete this and the assertion below once the package ships it,
 * and the compiler will point at every line that needs to change.
 */
interface ConversationChannelAddress {
  sourceChannel: string;
  externalChatId: string;
  externalUserId?: string | null;
  displayName?: string | null;
}

type RunTurnWithChannel = (options: {
  channel: ConversationChannelAddress;
  content: { type: "text"; text: string }[];
}) => Promise<{
  conversationId: string;
  queued?: boolean;
  content: { type: string; text?: string }[];
}>;

/**
 * Namespace an id to this plugin, matching what the gateway does.
 *
 * The gateway prefixes every external id with the plugin's directory name
 * before it dedups or gates (`pluginScopedId`), because one channel id covers
 * every installed plugin and two vendors addressing by phone number would
 * otherwise share conversations. Binding a turn under an unprefixed id would
 * put the conversation somewhere the gateway's own keys never point.
 */
/**
 * The canonical channel id for every plugin-delivered message.
 *
 * Not this plugin's name: the host reserves one id for all of them and
 * distinguishes plugins by the prefix on each external id.
 */
const PLUGIN_CHANNEL_ID = "plugin";

function scoped(value: string): string {
  return `${CHANNEL_ID}:${value}`;
}

/** The assistant's reply as plain text, or nothing when it said nothing. */
function replyTextFrom(blocks: { type: string; text?: string }[]): string {
  return blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text?.trim())
    .filter((text): text is string => Boolean(text))
    .join("\n\n");
}

export interface RunTurnResult {
  conversationId: string;
  /** False when the turn was queued behind another, so there is no reply yet. */
  replied: boolean;
}

/**
 * Run the turn and send whatever the assistant said back to the sender.
 *
 * The reply is sent from here rather than returned upward because the vendor's
 * webhook response is not a delivery channel: Comms and Photon answer a
 * webhook with an acknowledgement, not with a message to forward. The turn's
 * answer has to go out over the provider's own send API, addressed to the chat
 * the delivery came from.
 *
 * A queued turn sends nothing. The assistant is mid-turn on this conversation
 * and will answer when it drains; sending an empty reply now would put a blank
 * message in the thread.
 */
export async function runTurnForDelivery(opts: {
  event: PluginInboundEvent;
  provider: MessagingProvider;
}): Promise<RunTurnResult> {
  const { event, provider } = opts;

  const runTurn = runConversationTurn as unknown as RunTurnWithChannel;
  const turn = await runTurn({
    // Addressed exactly as the gateway addresses it. One channel id covers
    // every installed plugin, and the gateway's dedup keys, this channel's
    // contact records and its admission policy all sit under that id, with
    // the plugin's own name carried in the prefixes. Binding under anything
    // else would put the conversation where none of them point.
    channel: {
      sourceChannel: PLUGIN_CHANNEL_ID,
      externalChatId: scoped(event.message.conversationExternalId),
      externalUserId: scoped(event.actor.actorExternalId),
      displayName: event.actor.displayName ?? null,
    },
    content: [{ type: "text", text: event.message.content }],
  });

  if (turn.queued) {
    return { conversationId: turn.conversationId, replied: false };
  }

  const reply = replyTextFrom(turn.content);
  if (!reply) {
    return { conversationId: turn.conversationId, replied: false };
  }

  await provider.send(
    { to: event.message.conversationExternalId },
    reply,
    // Keyed on the message being answered, so a redelivery the gateway did not
    // absorb cannot put the same reply in the thread twice.
    { idempotencyKey: `reply:${event.message.externalMessageId}` },
  );

  return { conversationId: turn.conversationId, replied: true };
}
