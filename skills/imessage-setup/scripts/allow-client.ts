/**
 * Allow a Photon recipient without sending a message.
 *
 * Photon will only message people the project knows. A cold send registers
 * the recipient on the way out, but a setup check, and any later outbound
 * to a number that has never texted the line, still fails with "Target not
 * allowed for this project" until they are a project user.
 *
 * Registering them is not enough for the first outbound on a shared line.
 * The message plane still refuses until that number has texted in.
 * `assignedPhoneNumber` is the line they should text, when Photon returned one.
 *
 * This is the setup skill's half of that: one number by hand, or every
 * phone number already on the assistant's contacts. The plugin also allows
 * contacts when it registers the webhook; this script is for a number that
 * was added later, or a setup that ran before the contacts list was readable.
 */

import { phoneFromAddress } from "../../../src/channel/identity.ts";
import { loadContactPhoneNumbers } from "../../../src/channel/contact-phones.ts";
import { readConfigView } from "../../../src/app-settings.ts";
import { pluginConfigPath } from "../../../src/plugin-paths.ts";
import { resolveProvider } from "../../../src/providers/index.ts";
import type { ResolveProviderOptions } from "../../../src/providers/index.ts";
import type { MessagingProvider } from "../../../src/providers/types.ts";

export interface AllowResult {
  phoneNumber: string;
  assignedPhoneNumber?: string;
}

export interface AllowManyResult {
  allowed: AllowResult[];
  failed: { phone: string; reason: string }[];
}

export interface AllowDeps {
  photonMessageClient?: ResolveProviderOptions["photonMessageClient"];
  /** Test seam. Production reads the configured provider. */
  provider?: MessagingProvider;
  /** Test seam. Production shells out to `assistant contacts list --json`. */
  listContacts?: () => Promise<unknown>;
}

function providerOf(deps: AllowDeps): MessagingProvider {
  return (
    deps.provider ??
    resolveProvider({
      config: readConfigView(pluginConfigPath()),
      ...(deps.photonMessageClient
        ? { photonMessageClient: deps.photonMessageClient }
        : {}),
    })
  );
}

/**
 * Allow one handle, or throw with what is wrong.
 *
 * Delegates to the provider so a number allowed here and a number first
 * seen on send go through the same Photon user call. Comms has no such
 * restriction and says so rather than inventing a no-op success.
 */
export async function allowRecipient(
  raw: string,
  deps: AllowDeps = {},
): Promise<AllowResult> {
  const phone = phoneFromAddress(raw);
  if (!phone) {
    throw new Error(
      `"${raw}" is not a phone number Photon can allow. ` +
        "Use E.164, e.g. +15551234567.",
    );
  }

  const provider = providerOf(deps);
  if (!provider.allowRecipient) {
    throw new Error(
      `${provider.label} does not restrict recipients, so there is nothing to allow.`,
    );
  }

  return provider.allowRecipient(phone);
}

/**
 * What `--to` prints. The second line is the number they should text first.
 */
export function formatAllowRecipient(result: AllowResult): string {
  const lines = [`Allowed ${result.phoneNumber} on this Photon project.`];
  if (result.assignedPhoneNumber) {
    lines.push(
      `Ask them to text ${result.assignedPhoneNumber} from that number before any outbound. Photon's message plane refuses the first send to a number it has not heard from.`,
    );
  }
  return lines.join("\n");
}

/**
 * Allow every contact phone number the assistant already knows.
 *
 * Continues after a single failure so one full Photon project does not
 * hide the rest. The caller reports both lists.
 */
export async function allowContactPhones(
  deps: AllowDeps = {},
): Promise<AllowManyResult> {
  const provider = providerOf(deps);
  if (!provider.allowRecipient) {
    throw new Error(
      `${provider.label} does not restrict recipients, so there is nothing to allow.`,
    );
  }

  const phones = await loadContactPhoneNumbers(deps.listContacts);
  const allowed: AllowResult[] = [];
  const failed: { phone: string; reason: string }[] = [];

  for (const phone of phones) {
    try {
      const result = await provider.allowRecipient(phone);
      allowed.push(result);
    } catch (err) {
      failed.push({
        phone,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { allowed, failed };
}
