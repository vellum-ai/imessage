/**
 * Access to the host's contact lookup, across a version boundary.
 *
 * `findContactByChannelAddress` is added to `@vellumai/plugin-api` by
 * `vellum-assistant`; a host older than that release does not have it. Importing
 * it directly would fail to typecheck against the currently pinned package and
 * would throw an opaque "not a function" at runtime on an older host.
 *
 * So the lookup is resolved off the namespace at call time and its absence is
 * reported as what it is: a host too old to gate on contacts. `admit.ts` turns
 * that into a refusal, which is the right direction — a plugin that cannot
 * check whether a sender is known must not admit them.
 *
 * Delete this file and import from `@vellumai/plugin-api` directly once the
 * peer-dependency floor is above the release that adds it.
 */

import * as pluginApi from "@vellumai/plugin-api";

/**
 * A contact channel matching an inbound address.
 *
 * Mirrors `PluginContactMatch` in the host. `status` is optional on purpose:
 * `undefined` means the gateway could not be reached, which is unknown standing
 * rather than good standing.
 */
export interface HostContactMatch {
  contactId: string;
  displayName: string;
  channelType: string;
  address: string;
  status: string | undefined;
  verifiedAt: number | null | undefined;
}

type LookupFn = (
  channelType: string,
  address: string,
) => Promise<HostContactMatch | null>;

/** Whether the running host exposes contact lookup. */
export function hostSupportsContactLookup(): boolean {
  return (
    typeof (pluginApi as Record<string, unknown>).findContactByChannelAddress ===
    "function"
  );
}

/**
 * Look up a contact by channel address on the host.
 *
 * Throws when the host does not expose the lookup. Callers gating admission
 * must let that propagate into a refusal rather than swallowing it.
 */
export async function findContactByChannelAddress(
  channelType: string,
  address: string,
): Promise<HostContactMatch | null> {
  const lookup = (pluginApi as Record<string, unknown>)
    .findContactByChannelAddress as LookupFn | undefined;

  if (typeof lookup !== "function") {
    throw new Error(
      "this host's @vellumai/plugin-api does not expose findContactByChannelAddress; " +
        "upgrade the assistant to gate inbound iMessage on contacts",
    );
  }

  return lookup(channelType, address);
}
