import { afterEach, describe, expect, test } from "bun:test";

import {
  apiRequest,
  describeFailure,
  errorDetail,
} from "../../apps/imessage-settings/src/api.ts";

/**
 * The settings app's request layer.
 *
 * Both halves of this exist because the app once reported every failure as
 * "Failed to fetch": it called the global `fetch`, which cannot escape the
 * sandboxed iframe, and it had nothing to say about a response beyond its
 * status. So: requests go through `window.vellum`, and a failure carries
 * whatever the response actually said.
 */

/** Stand in for the bridge the host injects, without a DOM. */
function setBridge(
  fetchImpl: ((path: string, init?: unknown) => Promise<unknown>) | null,
): void {
  const globals = globalThis as { window?: unknown };
  if (fetchImpl === null) {
    delete globals.window;
    return;
  }
  globals.window = { vellum: { fetch: fetchImpl } };
}

function response(
  init: {
    ok?: boolean;
    status?: number;
    statusText?: string;
    body?: string;
    bodyError?: Error;
  } = {},
) {
  const status = init.status ?? 200;
  return {
    ok: init.ok ?? status < 300,
    status,
    statusText: init.statusText ?? "",
    headers: {},
    async text(): Promise<string> {
      if (init.bodyError) throw init.bodyError;
      return init.body ?? "";
    },
    async json(): Promise<unknown> {
      return JSON.parse(init.body ?? "");
    },
  };
}

afterEach(() => {
  setBridge(null);
});

describe("errorDetail", () => {
  test("prefers the route's own error field", () => {
    expect(errorDetail(JSON.stringify({ error: "invalid JSON body" }))).toBe(
      "invalid JSON body",
    );
  });

  test("folds field-level detail in alongside the error", () => {
    const body = JSON.stringify({
      error: "invalid settings update",
      detail: [
        { path: "pollIntervalMs", message: "too small" },
        { path: "ingressMode", message: "invalid option" },
      ],
    });
    expect(errorDetail(body)).toBe(
      "invalid settings update (pollIntervalMs: too small; ingressMode: invalid option)",
    );
  });

  test("falls back to a non-JSON body, which is how a proxy answers", () => {
    expect(errorDetail("<html>502 Bad Gateway</html>")).toBe(
      "<html>502 Bad Gateway</html>",
    );
  });

  test("reads a bare message field", () => {
    expect(errorDetail(JSON.stringify({ message: "nope" }))).toBe("nope");
  });

  test("keeps the raw body when JSON says nothing recognizable", () => {
    expect(errorDetail(JSON.stringify({ code: 7 }))).toBe('{"code":7}');
  });

  test("has nothing to say about an empty body", () => {
    expect(errorDetail("")).toBeNull();
    expect(errorDetail("   \n ")).toBeNull();
  });

  test("truncates a body too long for a banner", () => {
    const detail = errorDetail("x".repeat(1000));
    expect(detail).not.toBeNull();
    expect(detail!.length).toBeLessThan(310);
    expect(detail!.endsWith("…")).toBe(true);
  });
});

describe("describeFailure", () => {
  test("carries the status and the body's account of it", () => {
    expect(
      describeFailure(
        { status: 400, statusText: "Bad Request" },
        JSON.stringify({ error: "provider must be one of: vellum, comms" }),
      ),
    ).toBe("HTTP 400 Bad Request: provider must be one of: vellum, comms");
  });

  test("still says the status when the body is empty", () => {
    expect(describeFailure({ status: 500, statusText: "" }, "")).toBe("HTTP 500");
  });
});

describe("apiRequest", () => {
  test("returns the parsed body of a successful request", async () => {
    setBridge(async () => response({ body: JSON.stringify({ providers: [] }) }));
    expect(
      await apiRequest<{ providers: string[] }>(
        "Loading settings",
        "/x/plugins/imessage/settings",
      ),
    ).toEqual({ providers: [] });
  });

  test("goes through the bridge, with the path and init it was given", async () => {
    const calls: Array<{ path: string; init?: unknown }> = [];
    setBridge(async (path, init) => {
      calls.push({ path, init });
      return response({ body: "{}" });
    });

    await apiRequest("Switching to Comms by Osis", "/x/plugins/imessage/provider", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "comms" }),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe("/x/plugins/imessage/provider");
    expect(calls[0]?.init).toMatchObject({ method: "POST" });
  });

  test("names the missing bridge instead of failing opaquely", async () => {
    setBridge(null);
    await expect(
      apiRequest("Loading settings", "/x/plugins/imessage/settings"),
    ).rejects.toThrow(/window\.vellum/);
  });

  test("names the missing bridge when window exists without it", async () => {
    (globalThis as { window?: unknown }).window = {};
    await expect(
      apiRequest("Loading settings", "/x/plugins/imessage/settings"),
    ).rejects.toThrow(/window\.vellum/);
  });

  test("says what was being attempted when the request itself fails", async () => {
    setBridge(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(
      apiRequest("Loading settings", "/x/plugins/imessage/settings"),
    ).rejects.toThrow("Loading settings failed: Failed to fetch");
  });

  test("reports a route error with its status and body", async () => {
    setBridge(async () =>
      response({
        status: 400,
        statusText: "Bad Request",
        body: JSON.stringify({ error: "invalid JSON body" }),
      }),
    );
    await expect(
      apiRequest("Switching to Comms by Osis", "/x/plugins/imessage/provider"),
    ).rejects.toThrow(
      "Switching to Comms by Osis failed: HTTP 400 Bad Request: invalid JSON body",
    );
  });

  test("reports a failure whose body never arrives", async () => {
    setBridge(async () =>
      response({
        status: 502,
        statusText: "Bad Gateway",
        bodyError: new Error("bridge closed"),
      }),
    );
    await expect(
      apiRequest("Loading settings", "/x/plugins/imessage/settings"),
    ).rejects.toThrow("Loading settings failed: HTTP 502 Bad Gateway");
  });

  test("reports a 200 that is not JSON, which means something served HTML", async () => {
    setBridge(async () => response({ body: "<!doctype html><title>hi</title>" }));
    await expect(
      apiRequest("Loading settings", "/x/plugins/imessage/settings"),
    ).rejects.toThrow(/not JSON: <!doctype html>/);
  });

  test("reports a 200 with no body at all", async () => {
    setBridge(async () => response({ body: "" }));
    await expect(
      apiRequest("Loading settings", "/x/plugins/imessage/settings"),
    ).rejects.toThrow("Loading settings returned an empty body");
  });
});
