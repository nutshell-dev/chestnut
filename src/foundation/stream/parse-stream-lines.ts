/**
 * @module L2b.Stream.ParseStreamLines
 * Sync NDJSON (newline-delimited JSON) parser for incremental stream reading.
 * Encapsulates the stream.jsonl wire format: \n-delimited, JSON-per-line.
 *
 * @phase 749
 */

/**
 * Parse a raw string chunk of NDJSON, handling partial last line.
 * For incremental readers that read bytes from file offset.
 *
 * @param chunk - raw string (typically decoded from fs.readBytes)
 * @param leftover - previous partial line from last call (empty string on first call)
 * @returns parsed event objects (only valid objects with string `type` field) and new leftover
 */
export function parseStreamLines(
  chunk: string,
  leftover: string,
): { events: Record<string, unknown>[]; leftover: string } {
  const full = leftover + chunk;
  const lines = full.split('\n');
  const newLeftover = lines.pop() ?? '';
  const events: Record<string, unknown>[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // malformed JSON line — skip
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const ev = parsed as Record<string, unknown> & { type?: string };
    if (typeof ev.type !== 'string') continue;
    events.push(ev);
  }
  return { events, leftover: newLeftover };
}
