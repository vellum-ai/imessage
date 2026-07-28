/**
 * Platform API surface this provider depends on.
 *
 * Isolated in one file so the set of platform endpoints the plugin needs is a
 * single short list rather than something to grep for. Both paths follow the
 * email channel's shape: a per-assistant resource for provisioning, and the
 * runtime proxy for sends.
 */

/** Lines provisioned for this assistant. `{assistantId}` is substituted by the caller. */
export const PLATFORM_LINES_PATH =
  "/v1/assistants/{assistantId}/imessage-lines/";

/** Outbound send, proxied by the platform. */
export const PLATFORM_SEND_PATH = "/v1/runtime-proxy/imessage/send/";

/**
 * An authenticated call into the platform API.
 *
 * The plugin does not construct this: `@vellumai/plugin-api` exposes no
 * platform client, and reaching into the assistant's own client would break
 * the plugin boundary. The host supplies it, which also keeps assistant-id
 * substitution and token handling on the host side where they belong.
 */
export type PlatformFetch = (
  path: string,
  init?: RequestInit,
) => Promise<Response>;
