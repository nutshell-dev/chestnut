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
    const err = e as NodeJS.ErrnoException & { status?: number | null; signal?: NodeJS.Signals | null };
    // Known design-internal silent paths:
    //   (a) status === 1 + empty stdout = ps process-level 'target PID does not exist' (POSIX standard exit code)
    //   (b) code === 'ENOENT' = ps binary itself missing (rare; Windows is platform-guarded to early-return)
    const isProcessGone = err.status === 1;
    const isBinaryMissing = err.code === 'ENOENT';
    if (!isProcessGone && !isBinaryMissing) {
      // silent: non-ENOENT ps failure — caller decides skip-verify
    }
    return undefined; // caller decides skip-verify
  }
}
