/**
 * @module L2c.FileTool
 * Shared literal string replacement primitive for edit / multi_edit.
 *
 * phase 1109 Step B: decouples FileTool edits from JavaScript replacement-template
 * semantics (`$&`, ``$` ``, `$'`, `$$`, `\1`, `\g<1>` are all treated as literal
 * text, not special tokens).
 *
 * Constraints:
 * - Empty oldText is rejected as `not-found` (tool schema/structural validation
 *   already rejects it; this helper is defensive).
 * - Matches are non-overlapping, collected via `indexOf`.
 * - `unique` mode requires exactly one match; `all` mode requires >=1.
 * - Candidate content is built only with `slice` + `concatenate`, never with
 *   `String.replace` or regex substitution.
 */

export type LiteralReplaceMode = 'unique' | 'all';

export type LiteralReplaceResult =
  | {
      ok: true;
      content: string;
      matches: number;
      replaced: number;
      firstIndex: number;
    }
  | {
      ok: false;
      reason: 'not-found' | 'multiple-matches';
      matches: number;
    };

/**
 * Replace all literal occurrences of `oldText` with `newText` in `content`.
 *
 * The replacement is strictly literal: no regex or replacement-template
 * interpretation is applied to `newText`.
 */
export function literalReplace(
  content: string,
  oldText: string,
  newText: string,
  mode: LiteralReplaceMode,
): LiteralReplaceResult {
  if (oldText.length === 0) {
    return { ok: false, reason: 'not-found', matches: 0 };
  }

  const indices: number[] = [];
  let pos = 0;
  while ((pos = content.indexOf(oldText, pos)) !== -1) {
    indices.push(pos);
    pos += oldText.length;
  }

  const matches = indices.length;
  if (matches === 0) {
    return { ok: false, reason: 'not-found', matches: 0 };
  }

  if (mode === 'unique' && matches > 1) {
    return { ok: false, reason: 'multiple-matches', matches };
  }

  const replaced = mode === 'all' ? matches : 1;
  const firstIndex = indices[0];

  // Build candidate by slicing/concatenating only.
  const parts: string[] = [];
  let cursor = 0;
  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i];
    parts.push(content.slice(cursor, idx));
    parts.push(newText);
    cursor = idx + oldText.length;
  }
  parts.push(content.slice(cursor));

  return { ok: true, content: parts.join(''), matches, replaced, firstIndex };
}
