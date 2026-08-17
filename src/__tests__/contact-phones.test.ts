import { describe, expect, test } from "bun:test";

import { phoneNumbersFromContacts } from "../channel/contact-phones.ts";

describe("phoneNumbersFromContacts", () => {
  test("reads the HTTP/OpenAPI shape", () => {
    // `type` + `address` is what GET /v1/contacts returns.
    const phones = phoneNumbersFromContacts({
      ok: true,
      contacts: [
        {
          displayName: "Ada",
          channels: [
            { type: "phone", address: "+15551234567", status: "active" },
            { type: "telegram", address: "12345", status: "active" },
          ],
        },
      ],
    });
    expect(phones).toEqual(["+15551234567"]);
  });

  test("reads the CLI shape the contacts skill documents", () => {
    // `channel` + `externalUserId` is what `assistant contacts list --json`
    // has historically emitted. Missing one form would skip every contact
    // the setup skill actually lists.
    const phones = phoneNumbersFromContacts({
      ok: true,
      contacts: [
        {
          displayName: "Ada",
          channels: [
            {
              channel: "phone",
              externalUserId: "+15551234567",
              status: "active",
              policy: "allow",
            },
          ],
        },
      ],
    });
    expect(phones).toEqual(["+15551234567"]);
  });

  test("normalizes a national number", () => {
    const phones = phoneNumbersFromContacts({
      contacts: [
        {
          channels: [{ type: "phone", address: "(555) 123-4567" }],
        },
      ],
    });
    expect(phones).toEqual(["+15551234567"]);
  });

  test("skips blocked, revoked, and deny channels", () => {
    // Photon's user list is provisioning, not an override of the gateway ACL.
    // Allowing a blocked contact would let a later send through Photon even
    // though inbound from them is still refused.
    const phones = phoneNumbersFromContacts({
      contacts: [
        {
          channels: [
            { type: "phone", address: "+15550000001", status: "blocked" },
            { type: "phone", address: "+15550000002", status: "revoked" },
            {
              type: "phone",
              address: "+15550000003",
              status: "active",
              policy: "deny",
            },
            { type: "phone", address: "+15551234567", status: "active" },
          ],
        },
      ],
    });
    expect(phones).toEqual(["+15551234567"]);
  });

  test("skips a non-phone channel even when its id looks like a number", () => {
    // A 10-digit Telegram user id must not become a US phone number.
    const phones = phoneNumbersFromContacts({
      contacts: [
        {
          channels: [
            { type: "telegram", address: "5551234567" },
            { channel: "slack", externalUserId: "+15551234567" },
            { type: "phone", address: "+15557654321" },
          ],
        },
      ],
    });
    expect(phones).toEqual(["+15557654321"]);
  });

  test("dedupes the same number on two contacts", () => {
    const phones = phoneNumbersFromContacts({
      contacts: [
        { channels: [{ type: "phone", address: "+15551234567" }] },
        { channels: [{ type: "imessage", address: "5551234567" }] },
      ],
    });
    expect(phones).toEqual(["+15551234567"]);
  });

  test("accepts a bare array", () => {
    expect(
      phoneNumbersFromContacts([
        { channels: [{ type: "phone", address: "+15551234567" }] },
      ]),
    ).toEqual(["+15551234567"]);
  });

  test("returns nothing for an empty or unreadable payload", () => {
    expect(phoneNumbersFromContacts(undefined)).toEqual([]);
    expect(phoneNumbersFromContacts({})).toEqual([]);
    expect(phoneNumbersFromContacts({ contacts: [] })).toEqual([]);
    expect(phoneNumbersFromContacts("nope")).toEqual([]);
  });
});
