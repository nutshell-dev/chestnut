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
