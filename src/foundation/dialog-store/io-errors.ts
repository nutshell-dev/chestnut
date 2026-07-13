/**
 * DialogStore I/O error classification helpers.
 *
 * Phase 985: distinguishes transient/permanent I/O faults (EIO/EACCES/ENOSPC/EBUSY/EMFILE/ENFILE)
 * from file-not-found and parse corruption, so the store can decide whether to degrade gracefully
 * or fail fast and propagate the error.
 */

const FATAL_IO_CODES = new Set([
  'EIO',
  'EACCES',
  'ENOSPC',
  'EBUSY',
  'EMFILE',
  'ENFILE',
]);

/**
 * Returns true when `err` represents an OS-level I/O fault that should not be
 * silently degraded to a "not found" or "corrupted" path.
 */
export function isFatalIOError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as NodeJS.ErrnoException).code;
  return typeof code === 'string' && FATAL_IO_CODES.has(code);
}
