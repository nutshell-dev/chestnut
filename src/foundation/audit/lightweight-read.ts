/**
 * @module L2a.AuditLog.LightweightRead
 * Read-only audit file helpers for CLI diagnostic/troubleshooting scenarios.
 * AuditLog is append-only by design; these are diagnostic helpers, not query APIs.
 *
 * @phase 753
 * @phase 1074: return discriminated Result<T> to distinguish I/O errors from empty results.
 */

import type { FileSystem } from '../fs/index.js';
import { isFileNotFound } from '../fs/index.js';

/**
 * Discriminated result for lightweight audit helpers.
 * Only `not_found` is treated as an empty/ benign result; `io_error` is propagated
 * so callers can distinguish unreadable audits from missing audits.
 */
export type LightweightResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: 'not_found' | 'io_error' };

/**
 * Check if audit file contains a specific keyword anywhere in its content.
 * Reads entire file into memory — suitable for typical audit.tsv sizes (~MB range).
 */
export function auditFileContains(
  fs: FileSystem,
  auditPath: string,
  keyword: string,
): LightweightResult<boolean> {
  try {
    const content = fs.readSync(auditPath);
    return { ok: true, value: content.includes(keyword) };
  } catch (err) {
    if (isFileNotFound(err)) return { ok: true, value: false };
    return { ok: false, error: 'io_error' };
  }
}

/**
 * Read the first line's timestamp (first TSV field) from an audit file.
 * TSV format: <timestamp>\t<seq>\t<event>\t...
 */
export function auditFirstTimestamp(
  fs: FileSystem,
  auditPath: string,
): LightweightResult<string | null> {
  try {
    const content = fs.readSync(auditPath);
    const firstLine = content.split('\n').find(l => l.trim());
    if (!firstLine) return { ok: true, value: null };
    return { ok: true, value: firstLine.split('\t')[0] || null };
  } catch (err) {
    if (isFileNotFound(err)) return { ok: true, value: null };
    return { ok: false, error: 'io_error' };
  }
}

/**
 * Get audit file modification time (epoch ms).
 * For duration estimation when no explicit timestamp is available.
 */
export function auditFileGetMtime(
  fs: FileSystem,
  auditPath: string,
): LightweightResult<number | null> {
  try {
    return { ok: true, value: fs.statSync(auditPath).mtime.getTime() };
  } catch (err) {
    if (isFileNotFound(err)) return { ok: true, value: null };
    return { ok: false, error: 'io_error' };
  }
}
