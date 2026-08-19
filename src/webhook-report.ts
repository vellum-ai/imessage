/**
 * Words for a webhook registration report, shared by the runtime (which
 * returns them on a failed save) and the settings app (which paints them).
 *
 * Kept next to the report type rather than inlined in either caller so the
 * 400 a save returns and the banner the app shows cannot drift apart.
 */

import type {
  WebhookRegistrationReport,
  WebhookRegistrationStep,
} from "./plugin-state.ts";

/** What each registration step was doing, in words a reader can act on. */
export const WEBHOOK_STEP_LABELS: Record<WebhookRegistrationStep, string> = {
  "read-secret": "reading the stored webhook secret",
  "resolve-url": "working out this assistant's public URL",
  "call-provider": "asking the provider to register the webhook",
  "store-secret": "storing the secret the provider issued",
};

/**
 * One line about a failed registration.
 *
 * A failure names the step: four unrelated things can fail here and their
 * remedies have nothing in common, so "registration failed" alone leaves a
 * reader checking all four.
 */
export function describeWebhookFailure(
  report: WebhookRegistrationReport,
): string {
  const where = report.step ? WEBHOOK_STEP_LABELS[report.step] : undefined;
  return `Registration failed${where ? ` while ${where}` : ""}: ${
    report.reason ?? "no reason given"
  }`;
}
