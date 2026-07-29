/**
 * Message rendering: markdown flattening, chunking, idempotency keys.
 *
 * Deliberately dependency-free. Both the in-process transport and the
 * `imessage` skill's send script import from here, and the skill script runs
 * as a standalone bun process with no access to plugin state — so anything
 * this module pulled in would have to work in both worlds. Keeping it to pure
 * functions is what lets one implementation serve both, instead of the two
 * send paths drifting.
 */

import { createHash } from "node:crypto";

/**
 * Target size for one outgoing message.
 *
 * Chunked rather than truncated. An earlier version cut the reply at this
 * length and appended an ellipsis, which silently dropped the end of every
 * long answer — the recipient could not tell there had been more. Both
 * OpenClaw and Hermes chunk; so do we.
 */
export const MAX_CHUNK_LENGTH = 1_400;

/**
 * Hard ceiling on chunks per reply.
 *
 * A runaway generation should not fan out into fifty billed messages on
 * someone's phone. Past this the reply is cut, and `chunkForDelivery` says so
 * in the last chunk rather than ending mid-sentence with no explanation.
 */
export const MAX_CHUNKS = 5;

/**
 * Separator between the two parts of the idempotency input.
 *
 * Written as the escape `\u001f`, never typed inline: a raw control byte in
 * source makes git treat the whole file as binary, which hides it from diffs
 * and review entirely. `src/__tests__/source-hygiene.test.ts` enforces that.
 *
 * U+001F (unit separator) cannot occur in a phone number or a rendered message
 * body, so `("a b", "c")` and `("a", "b c")` cannot collide the way a space
 * separator would let them.
 */
const KEY_SEPARATOR = "\u001f";

/**
 * Stable key for a send.
 *
 * Derived from the target and the body so a retry of the same send collapses.
 * A genuinely repeated message differs by conversation state rather than by
 * this key, so the window is deliberately narrow: the same text to the same
 * target within the provider's idempotency retention is treated as one send.
 *
 * `sequence` distinguishes chunks of one reply. The body alone is not enough:
 * a long reply can legitimately contain two identical chunks, and keying on
 * body alone would have the provider collapse the second one and silently drop
 * it. Including the index keeps a genuine retry collapsing (same index, same
 * body) while keeping distinct chunks distinct.
 */
export function idempotencyKey(
  target: string,
  body: string,
  sequence = 0,
): string {
  return createHash("sha256")
    .update(`${target}${KEY_SEPARATOR}${sequence}${KEY_SEPARATOR}${body}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Flatten markdown to something that reads correctly in a message bubble.
 *
 * Deliberately lossy. The alternative is the recipient reading raw `**` and
 * backticks, which looks broken in a way plain prose does not.
 */
export function flattenForPlainText(text: string): string {
  let out = text.trim();
  if (!out) return "";

  // Fenced code: drop the fence, keep the contents.
  out = out.replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, (_m, code) =>
    String(code).trim(),
  );
  // Inline code, bold, italic, strikethrough.
  out = out.replace(/`([^`]+)`/g, "$1");
  out = out.replace(/\*\*([^*]+)\*\*/g, "$1");
  out = out.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "$1");
  out = out.replace(/~~([^~]+)~~/g, "$1");
  // Links: keep the label, append the URL so it stays tappable.
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1 ($2)");
  // Headings and blockquote markers.
  out = out.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  out = out.replace(/^\s{0,3}>\s?/gm, "");
  // Bullets to a character that renders in a bubble.
  out = out.replace(/^\s*[-*+]\s+/gm, "• ");
  // Collapse the blank-line runs markdown leaves behind.
  out = out.replace(/\n{3,}/g, "\n\n");

  return out.trim();
}

/**
 * Split a flattened reply into deliverable chunks.
 *
 * Breaks on the largest natural boundary that fits — paragraph, then line,
 * then sentence, then word — so a chunk boundary lands somewhere a reader
 * would pause rather than mid-word. Falls back to a hard cut only for a single
 * unbroken run longer than the limit (a URL, a hash).
 *
 * Returns `[]` for empty input: nothing to say is not an error.
 */
export function chunkForDelivery(text: string): string[] {
  const flattened = flattenForPlainText(text);
  if (!flattened) return [];
  if (flattened.length <= MAX_CHUNK_LENGTH) return [flattened];

  const chunks: string[] = [];
  let rest = flattened;

  while (rest.length > 0 && chunks.length < MAX_CHUNKS) {
    if (rest.length <= MAX_CHUNK_LENGTH) {
      chunks.push(rest);
      rest = "";
      break;
    }
    const cut = findBreakPoint(rest);
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }

  if (rest.length > 0) {
    // Out of chunks with text left over. Say so: a reply that just stops is
    // indistinguishable from a delivery failure.
    const last = chunks.length - 1;
    const notice = " [message truncated]";
    const room = MAX_CHUNK_LENGTH - notice.length;
    const body = chunks[last] ?? "";
    chunks[last] = `${body.length > room ? body.slice(0, room).trimEnd() : body}${notice}`;
  }

  return chunks;
}

/** Index just past the best break within the chunk limit. */
function findBreakPoint(text: string): number {
  const window = text.slice(0, MAX_CHUNK_LENGTH + 1);

  // Paragraph, then line, then sentence, then word.
  for (const pattern of [/\n\n(?![\s\S]*\n\n)/, /\n(?![\s\S]*\n)/]) {
    const match = window.match(pattern);
    if (match?.index !== undefined && match.index > 0) {
      return match.index + match[0].length;
    }
  }

  const sentence = lastIndexOfAny(window, [". ", "! ", "? ", ".\n"]);
  if (sentence > 0) return sentence + 2;

  const space = window.lastIndexOf(" ");
  if (space > 0) return space + 1;

  // One unbroken run longer than the limit. Hard cut is the only option.
  return MAX_CHUNK_LENGTH;
}

function lastIndexOfAny(text: string, needles: string[]): number {
  let best = -1;
  for (const needle of needles) {
    const at = text.lastIndexOf(needle);
    if (at > best) best = at;
  }
  return best;
}
