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
  /** Accumulated raw partial JSON input */
  buffer: string;
}

export function createSendContentTracker(): SendContentTracker {
  return { inContent: false, contentStart: 0, emitted: 0, buffer: '' };
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
  const cleaned = stripJsonClosing(raw);

  if (cleaned.length <= tracker.emitted) return null;

  const delta = cleaned.slice(tracker.emitted);
  tracker.emitted = cleaned.length;

  // Unescape JSON string escapes in the delta
  return unescapeJsonString(delta);
}

function stripJsonClosing(s: string): string {
  // Strip trailing " or "} that close the JSON string value and object
  let end = s.length;
  while (end > 0 && s[end - 1] === '}') end--;
  if (end > 0 && s[end - 1] === '"') {
    // Check for escaped quote before the closing "
    if (end >= 2 && s[end - 2] === '\\') {
      // It's an escaped quote inside the content — keep it for unescaping
    } else {
      end--;
    }
  }
  return s.slice(0, end);
}

function unescapeJsonString(s: string): string {
  // Simple JSON string unescape
  return s.replace(/\\(.)/g, (_match, char) => {
    switch (char) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case 'b': return '\b';
      case 'f': return '\f';
      default: return char; // \" → ", \\ → \, etc.
    }
  });
}
