/**
 * Inbound normalization for the platform-hosted line.
 *
 * The platform runs Comms underneath and forwards the provider event, so the
 * wire shape is the Comms one. This delegates rather than duplicating it: two
 * copies of the same tolerant schema would drift, and the drift would show up
 * as messages silently not becoming turns.
 *
 * If the platform ever wraps or re-shapes the event, this is the single place
 * that has to change, and the Comms adapter is unaffected.
 */

import { normalizeWebhookEvent } from "../comms/normalize.ts";
import type { PluginInboundEvent } from "../../channel/contract.ts";

export function normalizePlatformEvent(
  raw: unknown,
  receivedAt: string,
): PluginInboundEvent | undefined {
  return normalizeWebhookEvent(raw, receivedAt);
}
