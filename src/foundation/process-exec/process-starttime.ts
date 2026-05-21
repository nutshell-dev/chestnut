import { execFileSync } from 'child_process';

/**
 * Get process start time (cross-POSIX via `ps -o lstart=`).
 * Returns `undefined` on Windows / process gone / ps failure (skip-verify path).
 *
 * Format: `Sat May 18 10:30:00 2026` (lstart format, opaque string for equality compare)
 */
export function getProcessStartTime(pid: number): string | undefined {
  if (process.platform === 'win32') return undefined;
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      timeout: 1000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const trimmed = out.trim();
    return trimmed === '' ? undefined : trimmed;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[process-exec] getProcessStartTime: ps failed:', (e as Error).message);
    }
    return undefined; // process gone / ps fail (caller decides skip-verify)
  }
}
