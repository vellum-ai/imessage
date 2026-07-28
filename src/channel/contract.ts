/**
 * PLACEHOLDER for the channel-provider contract.
 *
 * The pluggable-channel work in `vellum-assistant` (the channel-provider
 * contract PR) will export these from `@vellumai/plugin-api`. Until it lands
 * there is nothing to import, so the shapes are declared here — mirroring
 * `gateway/src/channels/inbound-event.ts` and
 * `assistant/src/messaging/providers/channel-transport.ts` — so the rest of
 * this plugin can be written, tested, and reviewed against a real type.
 *
 * ## When the host contract lands
 *
 * Delete this file and re-point the imports in `normalize.ts`, `transport.ts`,
 * and `provider.ts` at `@vellumai/plugin-api`. Nothing else should need to
 * change if the host shape matches; where it does not, this file is the
 * complete list of assumptions to reconcile.
 *
 * The field names below are not invented — they are the ones the gateway
 * already uses, so a mismatch means the host contract deliberately diverged
 * and this plugin should follow it rather than the other way round.
 */

/**
 * A normalized inbound message, ready for the gateway's admission pipeline.
 *
 * Mirrors `InboundEventBase` in `gateway/src/channels/inbound-event.ts`,
 * minus the channel-specific fields (Slack team ids, Telegram callback
 * queries) that do not apply here.
 */
export interface PluginInboundEvent {
  version: "v1";
  /** Registered channel id. `"imessage"` for this plugin. */
  sourceChannel: string;
  /**
   * Gateway wall clock at receipt, never a provider-supplied timestamp.
   * Routing untrusted time into `new Date()` is a crash class, and receipt
   * time is the correct semantic anyway.
   */
  receivedAt: string;
  message: {
    content: string;
    /** Delivery address. Conversation binding only, never trust. */
    conversationExternalId: string;
    /** Provider message id. Dedup key. */
    externalMessageId: string;
  };
  actor: {
    /** Sender identity. Trust classification and admission key on this. */
    actorExternalId: string;
    displayName?: string;
  };
  source: {
    /** Provider-side update id for dedup across retries. */
    updateId: string;
    messageId?: string;
    chatType?: string;
  };
  /** The original payload, verbatim. */
  raw: Record<string, unknown>;
}

/** Rendered reply the host asks the plugin to deliver. */
export interface PluginReplyPayload {
  text?: string;
  chatAction?: "typing";
}

export interface PluginDeliveryResult {
  ok: boolean;
  error?: string;
  /** Provider id of the delivered message, when the send returned one. */
  externalMessageId?: string;
}

/**
 * Outbound half of a channel. Mirrors `ChannelTransport` in
 * `assistant/src/messaging/providers/channel-transport.ts`: `deliver` is
 * required, the rest are routed only when the payload carries the matching
 * field.
 */
export interface PluginChannelTransport {
  readonly channel: string;
  deliver(
    conversationExternalId: string,
    payload: PluginReplyPayload,
  ): Promise<PluginDeliveryResult>;
  sendTyping?(
    conversationExternalId: string,
  ): Promise<PluginDeliveryResult>;
}

/**
 * What a plugin registers to become a channel.
 *
 * `normalize` returning `undefined` means "not a turn" — an outbound echo, an
 * unattributable message, a delivery receipt. The host drops those silently
 * rather than treating them as errors.
 */
export interface PluginChannelProvider {
  readonly channel: string;
  normalize(raw: unknown, receivedAt: string): PluginInboundEvent | undefined;
  readonly transport: PluginChannelTransport;
}
