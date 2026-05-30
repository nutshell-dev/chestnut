/**
 * @module L2.FileTool
 * FileState — overwrite gate state per file path.
 *
 * phase 1430: replaces flat `fullyReadPaths: Set<string>` with three-field cache:
 *   - hash: SHA-256 of content the agent saw (32 bytes; tolerates mtime false-positives)
 *   - timestamp: file mtime at read time (used for staleness short-circuit)
 *   - isFullRead: true iff the read covered every current line + no byte-cap truncation
 *     + same-target. phase 1444 reframe: was "no offset/limit at all"; now an explicit
 *     `limit >= totalLines` read also qualifies (removes 200-line cliff that banned
 *     overwrite of files >200 lines).
 *
 * Map<resolvedPath, FileState> lives on ExecContext; lifecycle = daemon process.
 * Cross-target reads MUST NOT write to caller's map (see §7.A.invariant 2).
 */

import { createHash } from 'crypto';

export interface FileState {
  /** SHA-256 hex digest of content seen by the agent. */
  hash: string;
  /** File mtime (ms epoch) at the time of the read. */
  timestamp: number;
  /**
   * True iff the read covered every current line of the file:
   * (a) visible range started at line 1 (offset undefined OR offset === 1)
   * (b) visible range covered through the last line (end >= totalLines after slicing)
   * (c) output not byte-cap truncated (≤ READ_OUTPUT_HARD_CAP_BYTES)
   * (d) same-target read (no cross-target param)
   *
   * phase 1444 reframe: was "(a) offset/limit both undefined (b) no line cap";
   * now `limit >= totalLines` explicit reads also count, removing the 200-line
   * cliff that effectively banned overwrite of larger files.
   */
  isFullRead: boolean;
}

/** Compute SHA-256 hex digest of UTF-8 content (used for overwrite gate equality + mtime FP guard). */
export function computeContentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
