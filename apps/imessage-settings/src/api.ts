/**
 * Talking to the plugin's own routes from inside the app sandbox.
 *
 * Two jobs, both of which the app got wrong before and neither of which is
 * about rendering, so they live here where they can be tested without a DOM:
 * reaching the routes at all, and saying something useful when a request
 * fails.
 *
 * The type-only import is what declares `window.vellum`. It is erased at build
 * time, which matters: `@vellumai/plugin-api/app` ships types and no runtime
 * entry, and an app cannot rely on runtime imports inside the sandbox anyway.
 */

import type {
  VellumAppBridge,
  VellumAppFetchInit,
  VellumAppFetchResponse,
} from "@vellumai/plugin-api/app";

/** How much of a response body an error message is willing to carry. */
const MAX_DETAIL = 300;

function truncate(text: string): string {
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}…` : text;
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * One request through the host bridge.
 *
 * The app is served from a sandboxed iframe whose origin is not the
 * assistant's, so the bare global `fetch` cannot reach the plugin's routes and
 * would not carry the session if it could. The browser reports that as a bare
 * "Failed to fetch" with nothing else to go on, so a missing bridge names
 * itself here rather than surfacing as that same opaque message.
 */
function bridgeFetch(
  path: string,
  init?: VellumAppFetchInit,
): Promise<VellumAppFetchResponse> {
  // Reached through `globalThis` — which *is* `window` in the iframe — rather
  // than `window` directly, because this module is type-checked by the repo's
  // tsconfig, which has no DOM lib, and tested under Bun, which has no window.
  const host = globalThis as { window?: { vellum?: VellumAppBridge } };
  const vellum = host.window?.vellum;
  if (typeof vellum?.fetch !== "function") {
    throw new Error(
      "the host bridge (window.vellum) is unavailable, so this app cannot " +
        "reach the plugin — it has to run inside the assistant's workspace panel",
    );
  }
  return vellum.fetch(path, init);
}

/**
 * Whatever a body can say about a failure.
 *
 * These routes answer errors as `{ error, detail? }`, but a request can also
 * fail ahead of the route — at the host bridge, or at the gateway — and those
 * answer in a shape this app does not control. So: the route's own wording
 * when it is there, the raw body when it is not, and neither is guaranteed.
 */
export function errorDetail(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return truncate(trimmed);
  }
  if (typeof parsed === "string") return truncate(parsed.trim()) || null;
  if (parsed === null || typeof parsed !== "object") return truncate(trimmed);

  const body = parsed as {
    error?: unknown;
    message?: unknown;
    detail?: unknown;
  };
  const head =
    typeof body.error === "string"
      ? body.error
      : typeof body.message === "string"
        ? body.message
        : null;

  // A settings PATCH reports field-level problems as `detail: [{path, message}]`.
  let issues = "";
  if (typeof body.detail === "string") {
    issues = body.detail;
  } else if (Array.isArray(body.detail)) {
    issues = body.detail
      .map((issue) => {
        if (typeof issue === "string") return issue;
        const { path, message } = (issue ?? {}) as {
          path?: unknown;
          message?: unknown;
        };
        if (typeof message !== "string") return "";
        return path ? `${String(path)}: ${message}` : message;
      })
      .filter(Boolean)
      .join("; ");
  }

  if (head && issues) return truncate(`${head} (${issues})`);
  return truncate(head ?? issues) || truncate(trimmed);
}

/** Status line plus whatever the body adds to it. */
export function describeFailure(
  res: Pick<VellumAppFetchResponse, "status" | "statusText">,
  bodyText: string,
): string {
  const status = `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`;
  const detail = errorDetail(bodyText);
  return detail ? `${status}: ${detail}` : status;
}

/**
 * One request to a plugin route, where every failure names both what was being
 * attempted and what came back. `what` is a gerund phrase — "Loading settings"
 * — so the message reads as "Loading settings failed: HTTP 500: ...".
 */
export async function apiRequest<T>(
  what: string,
  path: string,
  init?: VellumAppFetchInit,
): Promise<T> {
  let res: VellumAppFetchResponse;
  try {
    res = await bridgeFetch(path, init);
  } catch (err) {
    throw new Error(`${what} failed: ${messageOf(err)}`);
  }

  // An unreadable body is not itself the failure: the status line still says
  // something, and a body that never arrives reads the same as an empty one.
  let text = "";
  try {
    text = await res.text();
  } catch {
    text = "";
  }

  if (!res.ok) throw new Error(`${what} failed: ${describeFailure(res, text)}`);

  try {
    return JSON.parse(text) as T;
  } catch {
    const body = text.trim();
    throw new Error(
      body
        ? `${what} returned a body that is not JSON: ${truncate(body)}`
        : `${what} returned an empty body`,
    );
  }
}
