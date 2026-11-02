/**
 * Send tool content streaming extractor.
 *
 * Extracts incremental content characters from partial JSON input as the LLM
 * streams the "send" tool call. The send tool schema is {"content": "..."}.
 *
 * Usage: create one tracker per send tool_use, feed each partialInput delta,
 * receive content delta strings (or null when no new content chars).
 */

const PREFIX_PATTERN = /"content"\s*:\s*"/;

interface SendContentTracker {
  inContent: boolean;
  /** Position in accumulated input where content value starts (after `"content": "`) */
  contentStart: number;
  /** How many characters of cleaned content have been emitted */
  emitted: number;
  /** Whether the closing quote of the content string has been observed */
  contentClosed: boolean;
  /** Accumulated raw partial JSON input */
  buffer: string;
}

export function createSendContentTracker(): SendContentTracker {
  return { inContent: false, contentStart: 0, emitted: 0, contentClosed: false, buffer: '' };
}

/**
 * Feed a new partial input chunk. Returns content delta string or null.
 * Handles JSON string escaping (\\", \\\\, \\n, \\t).
 */
export function feedSendContentDelta(
  tracker: SendContentTracker,
  partialInput: string,
): string | null {
  tracker.buffer += partialInput;

  if (!tracker.inContent) {
    const m = tracker.buffer.match(PREFIX_PATTERN);
    if (!m || m.index === undefined) return null;
    tracker.contentStart = m.index + m[0].length;
    tracker.inContent = true;
    tracker.emitted = 0;
  }

  // Extract raw content (from contentStart to end), strip JSON closing chars
  const raw = tracker.buffer.slice(tracker.contentStart);
  const { content, closed } = stripJsonClosing(raw);
  if (closed) tracker.contentClosed = true;

  const end = tracker.contentClosed
    ? content.length
    : safeEmitEnd(content, tracker.emitted);
  if (end <= tracker.emitted) return null;

  const delta = content.slice(tracker.emitted, end);
  tracker.emitted = end;

  return decodeJsonStringEscapes(delta, tracker.contentClosed);
}

function stripJsonClosing(s: string): { content: string; closed: boolean } {
  // Strip trailing " or "} that close the JSON string value and object
  let end = s.length;
  while (end > 0 && s[end - 1] === '}') end--;
  let closed = false;
  if (end > 0 && s[end - 1] === '"') {
    // Check for escaped quote before the closing "
    if (end >= 2 && s[end - 2] === '\\') {
      // It's an escaped quote inside the content — keep it for unescaping
    } else {
      end--;
      closed = true;
    }
  }
  return { content: s.slice(0, end), closed };
}

function safeEmitEnd(raw: string, from: number): number {
  let i = from;
  while (i < raw.length) {
    if (raw[i] !== '\\') {
      i += 1;
      continue;
    }
    if (i + 1 >= raw.length) return i;
    if (raw[i + 1] === 'u') {
      if (i + 6 > raw.length) return i;
      i += 6;
    } else {
      i += 2;
    }
  }
  return i;
}

function decodeJsonStringEscapes(raw: string, final: boolean): string {
  let out = '';
  for (let i = 0; i < raw.length;) {
    const ch = raw[i];
    if (ch !== '\\') {
      out += ch;
      i += 1;
      continue;
    }

    const esc = raw[i + 1];
    if (esc === undefined) {
      if (final) out += '\\';
      break;
    }

    switch (esc) {
      case 'n': out += '\n'; i += 2; break;
      case 't': out += '\t'; i += 2; break;
      case 'r': out += '\r'; i += 2; break;
      case 'b': out += '\b'; i += 2; break;
      case 'f': out += '\f'; i += 2; break;
      case '"': out += '"'; i += 2; break;
      case '\\': out += '\\'; i += 2; break;
      case '/': out += '/'; i += 2; break;
      case 'u': {
        const hex = raw.slice(i + 2, i + 6);
        if (hex.length < 4) {
          if (final) out += raw.slice(i);
          return out;
        }
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          // Keep the legacy lenient behavior for malformed complete escapes.
          out += 'u' + hex;
          i += 6;
          break;
        }

        const code = Number.parseInt(hex, 16);
        const lowEsc = raw.slice(i + 6, i + 8);
        const lowHex = raw.slice(i + 8, i + 12);
        if (
          code >= 0xd800 && code <= 0xdbff
          && lowEsc === '\\u' && /^[0-9a-fA-F]{4}$/.test(lowHex)
        ) {
          const low = Number.parseInt(lowHex, 16);
          if (low >= 0xdc00 && low <= 0xdfff) {
            out += String.fromCodePoint(
              0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00),
            );
            i += 12;
            break;
          }
        }
        out += String.fromCharCode(code);
        i += 6;
        break;
      }
      default:
        // Unknown escapes retain their displayable character, as before.
        out += esc;
        i += 2;
        break;
    }
  }
  return out;
}
