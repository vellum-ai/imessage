import { describe, expect, test } from "bun:test";

import { allowContactRecipients } from "../channel/photon-recipients.ts";
import type { MessagingProvider } from "../providers/types.ts";

const SILENT_LOGGER = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function providerWithAllow(
  allow: (handle: string) => Promise<{ phoneNumber: string }>,
): MessagingProvider {
  return {
    id: "photon",
    label: "Photon (your own project)",
    supportsPolling: true,
    supportsLive: true,
    checkReadiness: async () => ({ ready: true as const }),
    fetchInbound: async () => [],
    ensureWebhook: async () => ({ created: false }),
    send: async () => ({}),
    classifyWebhook: () => ({ kind: "ignored", reason: "test" }),
    allowRecipient: allow,
  };
}

describe("allowContactRecipients", () => {
  test("allows every contact phone and skips a provider that cannot", async () => {
    const seen: string[] = [];
    const photon = providerWithAllow(async (handle) => {
      seen.push(handle);
      return { phoneNumber: handle };
    });

    const result = await allowContactRecipients(photon, SILENT_LOGGER, async () => ({
      contacts: [
        {
          channels: [
            { type: "phone", address: "+15551234567" },
            { type: "phone", address: "+15557654321" },
          ],
        },
      ],
    }));

    expect(result).toEqual({
      allowed: ["+15551234567", "+15557654321"],
      failed: [],
    });
    expect(seen).toEqual(["+15551234567", "+15557654321"]);
  });

  test("does not invent a step on a provider that has no allowRecipient", async () => {
    const comms = {
      ...providerWithAllow(async () => ({ phoneNumber: "+1" })),
      id: "comms" as const,
      allowRecipient: undefined,
    };

    const result = await allowContactRecipients(comms, SILENT_LOGGER, async () => {
      throw new Error("should not list contacts");
    });

    expect(result).toEqual({ allowed: [], failed: [] });
  });

  test("a missing contacts list does not fail the caller", async () => {
    // Webhook registration awaits this. Throwing here would report the
    // webhook as failed when inbound is actually fine.
    const result = await allowContactRecipients(
      providerWithAllow(async (handle) => ({ phoneNumber: handle })),
      SILENT_LOGGER,
      async () => {
        throw new Error("assistant contacts list failed (127): not found");
      },
    );

    expect(result.allowed).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.listError).toContain("not found");
  });

  test("one refused number does not hide the rest", async () => {
    const result = await allowContactRecipients(
      providerWithAllow(async (handle) => {
        if (handle === "+15550000000") throw new Error("maxSharedUsers");
        return { phoneNumber: handle };
      }),
      SILENT_LOGGER,
      async () => ({
        contacts: [
          {
            channels: [
              { type: "phone", address: "+15550000000" },
              { type: "phone", address: "+15551234567" },
            ],
          },
        ],
      }),
    );

    expect(result.allowed).toEqual(["+15551234567"]);
    expect(result.failed).toEqual([
      { phone: "+15550000000", reason: "maxSharedUsers" },
    ]);
  });
});
