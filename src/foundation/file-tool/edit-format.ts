/**
 * @module L2.FileTool
 * edit / multi_edit shared format helpers (phase 1434).
 *
 * Provides a small self-implemented "diff context" renderer for the
 * tool-result preview (no external diff dependency).
 */

const CONTEXT_LINES = 3;

/**
 * Find the 1-based line number where `needle` first appears in `haystack`.
 * Returns null if no match.
 */
export function findFirstMatchLine(haystack: string, needle: string): number | null {
  if (!needle) return null;
  const pos = haystack.indexOf(needle);
  if (pos === -1) return null;
  let line = 1;
  for (let i = 0; i < pos; i++) {
    if (haystack.charCodeAt(i) === 10 /* \n */) line++;
  }
  return line;
}

/**
 * Render a small "around line N" context block showing the change.
 *
 * - Shows up to CONTEXT_LINES lines before the change anchor
 * - Shows removed lines prefixed with "- "
 * - Shows added lines prefixed with "+ "
 * - Shows up to CONTEXT_LINES lines after
 *
 * For multi-line oldText / newText: each line in the block is prefixed.
 * For empty newText (delete): only "- " lines appear in the change body.
 *
 * Returns '' if oldText is not found in `original` (defensive; callers
 * typically have already matched).
 */
export function formatEditDiff(
  original: string,
  oldText: string,
  newText: string,
): string {
  const startLine = findFirstMatchLine(original, oldText);
  if (startLine === null) return '';

  const oldLines = oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  const removedCount = oldLines.length;

  const allLines = original.split('\n');

  const beforeStart = Math.max(1, startLine - CONTEXT_LINES);
  const before = allLines.slice(beforeStart - 1, startLine - 1);

  const afterStart = startLine + removedCount;
  const after = allLines.slice(afterStart - 1, afterStart - 1 + CONTEXT_LINES);

  const out: string[] = [`@@ around line ${startLine} @@`];
  for (const l of before) out.push(`  ${l}`);
  for (const l of oldLines) out.push(`- ${l}`);
  for (const l of newLines) out.push(`+ ${l}`);
  for (const l of after) out.push(`  ${l}`);
  return out.join('\n');
}

/**
 * Count line delta after applying a single edit.
 * Positive = added lines, negative = removed lines.
 */
export function lineDelta(oldText: string, newText: string): number {
  const oldCount = oldText === '' ? 0 : oldText.split('\n').length;
  const newCount = newText === '' ? 0 : newText.split('\n').length;
  return newCount - oldCount;
}

// ── phase 1456: error diagnostic helpers ─────────────────────────────────

/** Max lines scanned in findNearMatches for files larger than this threshold. */
const NEAR_MATCH_SCAN_LINE_LIMIT = 5000;

/** Truncate line text shown in diagnostics so a single huge line doesn't blow context. */
const NEAR_MATCH_LINE_TEXT_MAX = 200;

export interface NearMatch {
  /** 1-based line number where the partial match appears. */
  line: number;
  /** The line text (trimmed; truncated to NEAR_MATCH_LINE_TEXT_MAX). */
  text: string;
  /** Why this line was flagged: structural reason agent can act on. */
  score: 'exact-prefix' | 'whitespace-diff' | 'partial-substring';
}

/** Normalize whitespace runs to a single space for whitespace-diff comparison. */
function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Truncate a line text safely for display. */
function clipLineText(line: string): string {
  const trimmed = line.trim();
  if (trimmed.length <= NEAR_MATCH_LINE_TEXT_MAX) return trimmed;
  return trimmed.slice(0, NEAR_MATCH_LINE_TEXT_MAX) + '… [truncated]';
}

/**
 * Find lines that nearly match `needle`. Returns at most `opts.limit` matches
 * (default 3), prioritized: exact-prefix > whitespace-diff > partial-substring.
 *
 * Heuristics (cheap, no fuzzy-match library):
 *   1. exact-prefix: line contains the first min(20, needle.length) chars of needle
 *   2. whitespace-diff: line contains needle after whitespace normalization
 *   3. partial-substring: any 20-char run of needle appears in line
 *
 * For files larger than NEAR_MATCH_SCAN_LINE_LIMIT (5000) lines, scans only
 * the first 5000 to bound cost. Returns empty array if nothing found.
 *
 * Only the first line of `needle` is used as the search target (multi-line
 * needles have their first line scanned — if even that doesn't appear nearby,
 * the agent's oldText is likely far off and full re-read is the right answer).
 */
export function findNearMatches(
  content: string,
  needle: string,
  opts: { limit?: number } = {},
): NearMatch[] {
  if (!needle) return [];
  const limit = opts.limit ?? 3;
  const lines = content.split('\n');
  const scanCount = Math.min(lines.length, NEAR_MATCH_SCAN_LINE_LIMIT);

  // Use the first line of needle as the search target (multi-line needles).
  const needleFirstLine = needle.split('\n')[0];
  if (!needleFirstLine) return [];

  const prefixLen = Math.min(20, needleFirstLine.length);
  const prefix = needleFirstLine.slice(0, prefixLen);
  const wsNormalized = normalizeWhitespace(needleFirstLine);

  const seen = new Set<number>();
  const matches: NearMatch[] = [];

  // Pass 1: exact-prefix (strongest signal)
  for (let i = 0; i < scanCount && matches.length < limit; i++) {
    if (lines[i].includes(prefix)) {
      seen.add(i);
      matches.push({ line: i + 1, text: clipLineText(lines[i]), score: 'exact-prefix' });
    }
  }
  if (matches.length >= limit) return matches;

  // Pass 2: whitespace-diff (medium signal)
  for (let i = 0; i < scanCount && matches.length < limit; i++) {
    if (seen.has(i)) continue;
    if (normalizeWhitespace(lines[i]).includes(wsNormalized)) {
      seen.add(i);
      matches.push({ line: i + 1, text: clipLineText(lines[i]), score: 'whitespace-diff' });
    }
  }
  if (matches.length >= limit) return matches;

  // Pass 3: partial-substring (weakest signal; only if needle is long enough)
  if (needleFirstLine.length >= 20) {
    const runLen = 20;
    for (let i = 0; i < scanCount && matches.length < limit; i++) {
      if (seen.has(i)) continue;
      for (let start = 0; start + runLen <= needleFirstLine.length; start++) {
        const run = needleFirstLine.slice(start, start + runLen);
        if (lines[i].includes(run)) {
          matches.push({ line: i + 1, text: clipLineText(lines[i]), score: 'partial-substring' });
          break;
        }
      }
    }
  }

  return matches;
}

/**
 * Find all 1-based line numbers where `needle` first occurs on each match.
 * Returns up to `limit` line numbers (default 5); caller appends overflow indicator.
 */
export function findAllMatchLines(content: string, needle: string, limit = 5): number[] {
  if (!needle) return [];
  const result: number[] = [];
  let pos = 0;
  while ((pos = content.indexOf(needle, pos)) !== -1) {
    let line = 1;
    for (let i = 0; i < pos; i++) {
      if (content.charCodeAt(i) === 10) line++;
    }
    result.push(line);
    if (result.length >= limit) break;
    pos += needle.length;
  }
  return result;
}
