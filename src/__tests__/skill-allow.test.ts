/**
 * The `imessage-setup` skill's Photon allow path.
 *
 * Same seam as the send script: `resolveCredential` is mocked, `fetch` is
 * stubbed, and allowing a number comes out the other side as a real control-
 * plane `POST /users/` rather than a second copy of that call.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const realPluginApi = await import("@vellumai/plugin-api");

const credentials: Record<string, string> = {
  photon_project_id: "proj_1",
  photon_project_secret: "shh",
  api_key: "sk-comms",
};

mock.module("@vellumai/plugin-api", () => ({
  ...realPluginApi,
  resolveCredential: mock(async (ref: string) => {
    const field = ref.split("/")[1] ?? "";
    const value = credentials[field];
    if (!value) throw new Error(`no credential for ${ref}`);
    return value;
  }),
}));

const { allowContactPhones, allowRecipient } = await import(
  "../../skills/imessage-setup/scripts/allow-client.ts"
);

interface Call {
  url: string;
  init: RequestInit;
}

const originalFetch = globalThis.fetch;
let calls: Call[] = [];

function stubControlPlane(): void {
  globalThis.fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    const href = String(url);
    calls.push({ url: href, init: init ?? {} });

    if (href.endsWith("/imessage/")) {
      return Response.json({ succeed: true, data: { type: "shared" } });
    }
    if (href.endsWith("/users/")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        phoneNumber?: string;
      };
      return Response.json({
        succeed: true,
        data: { id: "usr_1", phoneNumber: body.phoneNumber },
      });
    }
    return Response.json({
      succeed: true,
      data: { type: "shared", token: "tok_live", expiresIn: 600 },
    });
  }) as unknown as typeof fetch;
}

function pathsCalled(): string[] {
  return calls.map((call) => new URL(call.url).pathname);
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("skill allow", () => {
  test("registers the number as a Photon user and sends nothing", async () => {
    stubControlPlane();
    const result = await allowRecipient("+15551234567");

    expect(result).toEqual({ phoneNumber: "+15551234567" });
    expect(pathsCalled()).toEqual([
      "/projects/proj_1/imessage/",
      "/projects/proj_1/users/",
    ]);
    const registration = calls.find((c) =>
      new URL(c.url).pathname.endsWith("/users/"),
    );
    expect(JSON.parse(String(registration?.init.body))).toEqual({
      type: "shared",
      phoneNumber: "+15551234567",
    });
    // Allowing is control-plane only. Minting a message-plane token here
    // would be a round trip that buys nothing, and would make a setup
    // script look like it was about to send.
    expect(pathsCalled().some((p) => p.endsWith("/imessage/tokens"))).toBe(
      false,
    );
  });

  test("normalizes a national number before posting it", async () => {
    stubControlPlane();
    const result = await allowRecipient("(555) 123-4567");

    expect(result.phoneNumber).toBe("+15551234567");
    const registration = calls.find((c) =>
      new URL(c.url).pathname.endsWith("/users/"),
    );
    expect(JSON.parse(String(registration?.init.body)).phoneNumber).toBe(
      "+15551234567",
    );
  });

  test("pulls the phone out of a chat guid", async () => {
    stubControlPlane();
    const result = await allowRecipient("any;-;+15551234567");
    expect(result.phoneNumber).toBe("+15551234567");
  });

  test("refuses an unaddressable handle before calling Photon", async () => {
    stubControlPlane();
    await expect(allowRecipient("12345")).rejects.toThrow(/not a phone number/);
    expect(calls).toHaveLength(0);
  });

  test("allows every contact phone and continues after one failure", async () => {
    globalThis.fetch = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      const href = String(url);
      calls.push({ url: href, init: init ?? {} });
      if (href.endsWith("/imessage/")) {
        return Response.json({ succeed: true, data: { type: "shared" } });
      }
      if (href.endsWith("/users/")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          phoneNumber?: string;
        };
        if (body.phoneNumber === "+15550000000") {
          return Response.json({
            succeed: false,
            message: "maxSharedUsers reached",
          });
        }
        return Response.json({
          succeed: true,
          data: { id: "usr_1", phoneNumber: body.phoneNumber },
        });
      }
      return Response.json({ succeed: true, data: {} });
    }) as unknown as typeof fetch;

    const result = await allowContactPhones({
      listContacts: async () => ({
        contacts: [
          {
            channels: [
              { type: "phone", address: "+15550000000" },
              { type: "phone", address: "+15551234567" },
            ],
          },
        ],
      }),
    });

    expect(result.allowed).toEqual(["+15551234567"]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.phone).toBe("+15550000000");
    expect(result.failed[0]?.reason).toContain("maxSharedUsers");
  });

  test("says so when there are no contact phones", async () => {
    stubControlPlane();
    const result = await allowContactPhones({
      listContacts: async () => ({ contacts: [] }),
    });
    expect(result).toEqual({ allowed: [], failed: [] });
    expect(pathsCalled()).toEqual([]);
  });
});
