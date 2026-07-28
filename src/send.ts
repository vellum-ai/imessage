/**
 * Outbound send, shared by the tool and the test route.
 *
 * Goes through the channel transport rather than calling a provider directly,
 * so a send here exercises the same path a real assistant reply will: markdown
 * flattening, idempotency-key derivation, and target routing. A test path that
 * bypassed the transport would prove the Comms credentials work and nothing
 * else.
 */

import { normalizeHandle } from "./channel/identity.ts";
import { getChannel, getConfig, getProvider } from "./plugin-state.ts";

export type SendOutcome =
  | { ok: true; to: string; externalMessageId?: string }
  | { ok: false; error: string };

/**
 * Send one message to a handle.
 *
 * The handle is normalized first, for the same reason inbound handles are: a
 * raw `(555) 123-4567` would reach the provider as a malformed address, and
 * failing here with a clear message beats a provider 4xx.
 */
export async function sendMessage(
  rawTo: string,
  body: string,
): Promise<SendOutcome> {
  const channel = getChannel();
  const provider = getProvider();
  if (!channel || !provider) {
    return {
      ok: false,
      error: idleError(),
    };
  }

  const to = normalizeHandle(rawTo);
  if (!to) {
    return {
      ok: false,
      error: `"${rawTo}" is not a phone number this channel can address. Use E.164, e.g. +15551234567.`,
    };
  }

  if (!body.trim()) {
    return { ok: false, error: "message body is empty" };
  }

  const result = await channel.transport.deliver(to, { text: body });
  if (!result.ok) {
    return { ok: false, error: result.error ?? "send failed" };
  }

  return { ok: true, to, externalMessageId: result.externalMessageId };
}

/**
 * Why there is nothing to send through, phrased as the next action.
 *
 * The common case during bring-up is the default `vellum` provider with no
 * host platform caller, which leaves the channel idle. Saying "not
 * initialized" would send someone hunting for a crash that did not happen.
 */
function idleError(): string {
  const configured = getConfig()?.provider;
  if (configured === "vellum") {
    return (
      "The iMessage channel is idle: the vellum provider needs a platform caller the host does not supply yet. " +
      'Switch to your own Comms account to send today: set `{"provider":"comms"}` in the plugin config, ' +
      "or POST it to /x/plugins/imessage/provider."
    );
  }
  return "The iMessage channel is not running. Check the plugin's settings app for the reason it is idle.";
}
