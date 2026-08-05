/**
 * Turning a provider's error response into something a person can act on.
 *
 * Both clients already read the failing response body and hang it off the
 * thrown error. Nothing ever read it back: every surface that reports a
 * failure — the skill script, the channel transport, the daemon log — prints
 * `err.message`, and the message carried only the status. So a real answer
 * from the provider ("unsupported content type", "chat guid not found",
 * "scope comms_send missing") arrived as `POST /v1/chats failed: 415` and the
 * explanation was dropped one frame below the person who needed it.
 *
 * That is worse than it sounds. A bare status is not enough to decide
 * anything, so the reasonable next move is to guess: re-check the credential,
 * re-confirm the config, try a different endpoint. None of it produces new
 * information, and the loop can run for a long time.
 *
 * So the body goes in the message. It is untrusted, unbounded text from a
 * third party landing in logs, which is what the shaping below is for.
 */

/**
 * Longest body excerpt to carry.
 *
 * Enough for a sentence or a small JSON error, short of an HTML error page
 * pasted into every log line.
 */
const MAX_DETAIL_LENGTH = 300;

/** Fields providers use for the human-readable half of an error envelope. */
const MESSAGE_KEYS = ["message", "error", "detail", "error_description"];

/**
 * Pull the readable part out of a JSON error envelope.
 *
 * A provider that answers `{"error":{"message":"..."}}` should report that
 * sentence, not the punctuation around it. Nested one level because that is
 * where the shape usually is; anything deeper falls back to the raw text,
 * which is still better than nothing.
 */
function messageFromJson(parsed: unknown): string | undefined {
  if (!parsed || typeof parsed !== "object") return undefined;
  const record = parsed as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
    if (value && typeof value === "object") {
      const nested = messageFromJson(value);
      if (nested) return nested;
    }
  }
  return undefined;
}

/**
 * A one-line excerpt of an error body, or `undefined` when there is nothing
 * worth saying.
 *
 * Collapsed to a single line because the result goes into log lines and CLI
 * stderr, where an embedded newline splits one failure into what looks like
 * several.
 */
export function errorBodyDetail(body: string | undefined): string | undefined {
  if (!body) return undefined;

  let text = body;
  try {
    text = messageFromJson(JSON.parse(body)) ?? body;
  } catch {
    // Not JSON — an HTML page or plain text. Use it as it came.
  }

  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) return undefined;

  return collapsed.length > MAX_DETAIL_LENGTH
    ? `${collapsed.slice(0, MAX_DETAIL_LENGTH)}…`
    : collapsed;
}

/**
 * `<label> failed: <status>`, plus what the provider said about it.
 *
 * The status stays first so the shape of every failure is the same and greps
 * still work; the detail is appended rather than substituted because a status
 * alone is what makes a failure classifiable, and the body is what makes it
 * fixable.
 */
export function describeApiFailure(
  label: string,
  status: number,
  body: string | undefined,
): string {
  const detail = errorBodyDetail(body);
  return detail
    ? `${label} failed: ${status} — ${detail}`
    : `${label} failed: ${status}`;
}
