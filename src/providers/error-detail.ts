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

/**
 * Everything a caught error knows, as one line.
 *
 * `err.message` alone is what left a real incident undiagnosable: the plugin's
 * webhook registration failed five seconds after a restart, reported one
 * sentence, and the sentence did not contain the cause. Three things were
 * missing from it.
 *
 * **The cause chain.** `fetch` rejects with a bare `TypeError: fetch failed`
 * and puts the real answer — ECONNREFUSED, a DNS failure, a TLS error — on
 * `.cause`. Reading only `.message` reports the least informative frame of the
 * error and discards the only one that says what happened. Causes are followed
 * to a bounded depth and appended, so a wrapped error reads as the chain it is.
 *
 * **The status.** `CommsApiError` and `PhotonApiError` carry the HTTP status
 * they were built from, and it is what separates "the key is wrong" (401) from
 * "the scope is missing" (403) from "the provider is down" (503). It is
 * already in the message for those two, but any other error carrying a
 * `status` gets it named here rather than dropped.
 *
 * **The type.** A `TypeError` and an `Error` mean different things at the same
 * message text, and the name is one word.
 *
 * Bounded and single-line for the same reason {@link errorBodyDetail} is: this
 * goes into log lines and into the settings app, and an unbounded cause chain
 * from a third-party library would bury the failure it is meant to explain.
 */
export function describeError(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;

  // Three frames is enough for `fetch` → undici → syscall, which is the chain
  // that actually matters here, and short of a library that wraps ten deep.
  for (let depth = 0; depth < 3 && current !== undefined && current !== null; depth++) {
    parts.push(describeOneError(current, depth));
    current = current instanceof Error ? current.cause : undefined;
  }

  const line = parts.filter(Boolean).join(": caused by ");
  return line.length > MAX_DETAIL_LENGTH
    ? `${line.slice(0, MAX_DETAIL_LENGTH)}…`
    : line;
}

/** One frame of {@link describeError}'s chain. */
function describeOneError(err: unknown, depth: number): string {
  if (!(err instanceof Error)) {
    return String(err).replace(/\s+/g, " ").trim();
  }

  const message = err.message.replace(/\s+/g, " ").trim();
  // The outermost frame names its type, because `TypeError: fetch failed` and
  // `Error: fetch failed` are different diagnoses. Inner frames do not: the
  // chain is already attributed by the frame above it.
  const named =
    depth === 0 && err.name && err.name !== "Error"
      ? `${err.name}: ${message}`
      : message;

  const status = (err as { status?: unknown }).status;
  // Only when it is not already in the message — both API error types build
  // their message from `describeApiFailure`, which leads with the status.
  return typeof status === "number" && !named.includes(String(status))
    ? `${named} (status ${status})`
    : named;
}
