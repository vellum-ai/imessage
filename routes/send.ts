/**
 * `POST /x/plugins/imessage/send`: send one message.
 *
 * The same outbound path the `send_imessage` tool takes, reachable with curl
 * so outbound can be tested without going through the agent loop. Useful when
 * bringing the channel up: it isolates "does the provider send" from "does the
 * assistant decide to send".
 *
 * Body: `{ "to": "+15551234567", "body": "hello" }`
 */

import { sendMessage } from "../src/send.ts";

export async function POST(request: Request): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json(400, { error: "invalid JSON body" });
  }

  const { to, body } = (payload ?? {}) as { to?: unknown; body?: unknown };
  if (typeof to !== "string" || typeof body !== "string") {
    return json(400, { error: "`to` and `body` are both required strings" });
  }

  const result = await sendMessage(to, body);
  if (!result.ok) {
    return json(422, { error: result.error });
  }

  return json(200, {
    ok: true,
    to: result.to,
    externalMessageId: result.externalMessageId ?? null,
  });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
