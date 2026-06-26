/**
 * @module L2a.AuditLog.LightweightRead
 * Read-only audit file helpers for CLI diagnostic/troubleshooting scenarios.
 * AuditLog is append-only by design; these are diagnostic helpers, not query APIs.
 *
 * @phase 753
 */

import type { FileSystem } from '../fs/index.js';

/**
 * Check if audit file contains a specific keyword anywhere in its content.
 * Reads entire file into memory — suitable for typical audit.tsv sizes (~MB range).
 */
export function auditFileContains(
  fs: FileSystem,
  auditPath: string,
  keyword: string,
): boolean {
  if (!fs.existsSync(auditPath)) return false;
  try {
    const content = fs.readSync(auditPath);
    return content.includes(keyword);
  } catch {
    return false;
  }
}

/**
 * Get audit file modification time (epoch ms).
 * For duration estimation when no explicit timestamp is available.
 */
export function auditFileGetMtime(
  fs: FileSystem,
  auditPath: string,
): number | null {
  if (!fs.existsSync(auditPath)) return null;
  try {
    return fs.statSync(auditPath).mtime.getTime();
  } catch {
    return null;
  }
}
