/**
 * Admission tests.
 *
 * This is the only thing between a stranger's text and the agent loop until the
 * host's channel pipeline accepts plugin-supplied inbound, so every case here
 * is about it refusing when it cannot be sure.
 */

import { describe, expect, test } from "bun:test";

import { admitSender } from "../channel/admit.ts";
import type { HostContactMatch } from "../host-contacts.ts";

function contact(overrides: Partial<HostContactMatch> = {}): HostContactMatch {
  return {
    contactId: "contact_1",
    displayName: "Dana",
    channelType: "phone",
    address: "+15551234567",
    status: "active",
    verifiedAt: 1_700_000_000_000,
    ...overrides,
  };
}

/** Lookup stub returning a match only for the listed channel types. */
function lookupFor(
  matches: Record<string, HostContactMatch | null>,
): { lookup: typeof import("../host-contacts.ts").findContactByChannelAddress; tried: string[] } {
  const tried: string[] = [];
  const lookup = async (channelType: string, _address: string) => {
    tried.push(channelType);
    return matches[channelType] ?? null;
  };
  return { lookup, tried };
}

describe("admitSender", () => {
  test("admits an active contact", async () => {
    const { lookup } = lookupFor({ phone: contact() });

    const decision = await admitSender({
      actorExternalId: "+15551234567",
      lookup,
    });

    expect(decision.admit).toBe(true);
    if (decision.admit) expect(decision.contact.displayName).toBe("Dana");
  });

  test("refuses a sender who is not a contact", async () => {
    // The whole point: an unknown number does not reach the agent loop.
    const { lookup } = lookupFor({});

    const decision = await admitSender({
      actorExternalId: "+15559990000",
      lookup,
    });

    expect(decision.admit).toBe(false);
    if (!decision.admit) expect(decision.reason).toContain("not a known contact");
  });

  test("refuses when the gateway could not report a status", async () => {
    // undefined means the ACL read failed. Unknown standing is not good
    // standing, and defaulting the other way would silently open the gate.
    const { lookup } = lookupFor({ phone: contact({ status: undefined }) });

    const decision = await admitSender({
      actorExternalId: "+15551234567",
      lookup,
    });

    expect(decision.admit).toBe(false);
    if (!decision.admit) expect(decision.reason).toContain("unknown");
  });

  test("refuses every non-active status", async () => {
    for (const status of ["pending", "unverified", "revoked", "blocked"]) {
      const { lookup } = lookupFor({ phone: contact({ status }) });

      const decision = await admitSender({
        actorExternalId: "+15551234567",
        lookup,
      });

      expect(decision.admit).toBe(false);
      if (!decision.admit) expect(decision.reason).toContain(status);
    }
  });

  test("refuses when the lookup throws", async () => {
    // An older host with no contact lookup lands here. A plugin that cannot
    // check whether a sender is known must not admit them.
    const lookup = async () => {
      throw new Error("host does not expose findContactByChannelAddress");
    };

    const decision = await admitSender({
      actorExternalId: "+15551234567",
      lookup,
    });

    expect(decision.admit).toBe(false);
    if (!decision.admit) expect(decision.reason).toContain("lookup failed");
  });

  test("tries the imessage channel type before phone", async () => {
    // phone is where an E.164 handle lives today; imessage is checked first so
    // a dedicated contact channel wins once the vocabulary grows one.
    const { lookup, tried } = lookupFor({});

    await admitSender({ actorExternalId: "+15551234567", lookup });

    expect(tried).toEqual(["imessage", "phone"]);
  });

  test("stops at the first channel type that matches", async () => {
    const { lookup, tried } = lookupFor({
      imessage: contact({ channelType: "imessage" }),
      phone: contact(),
    });

    const decision = await admitSender({
      actorExternalId: "+15551234567",
      lookup,
    });

    expect(decision.admit).toBe(true);
    expect(tried).toEqual(["imessage"]);
  });

  test("a blocked match is not retried under another channel type", async () => {
    // Falling through to phone after a blocked imessage row would let a
    // blocked contact back in through the side door.
    const { lookup, tried } = lookupFor({
      imessage: contact({ channelType: "imessage", status: "blocked" }),
      phone: contact(),
    });

    const decision = await admitSender({
      actorExternalId: "+15551234567",
      lookup,
    });

    expect(decision.admit).toBe(false);
    expect(tried).toEqual(["imessage"]);
  });
});
