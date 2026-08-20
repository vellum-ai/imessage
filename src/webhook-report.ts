/**
 * Words for a webhook registration report, shared by the runtime (which
 * returns them on a failed save) and the settings app (which paints them).
 *
 * Kept next to the report type rather than inlined in either caller so the
 * 400 a save returns and the banner the app shows cannot drift apart.
 */

import type { WebhookRegistrationReport } from "./plugin-state.ts";

/**
 * One line about a failed registration.
 *
 * The provider's own reason is what a reader can act on. The step id is
 * included in parentheses when present so the four registration failures stay
 * distinguishable without a long prefix eating the banner.
 */
export function describeWebhookFailure(
  report: WebhookRegistrationReport,
): string {
  const step = report.step ? ` (${report.step})` : "";
  return `Webhook registration failed${step}: ${
    report.reason ?? "no reason given"
  }`;
}
