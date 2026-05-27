/**
 * @module L1.ProcessExec
 *
 * Find processes by command pattern (POSIX pgrep + ps).
 */

import { spawnSync } from 'child_process';
import { ProcessListUnavailable } from './errors.js';
import type { ProcessInfo } from './types.js';

/**
 * Find processes matching pattern. Returns pids + command strings.
 *
 * @throws ProcessListUnavailable if pgrep binary not available.
 */
export function findByPattern(pattern: string): ProcessInfo[] {
  let pids: number[];
  try {
    const result = spawnSync('pgrep', ['-f', pattern], { encoding: 'utf-8' });
    if (result.error) throw new ProcessListUnavailable(pattern, result.error);
    if (result.status === 1) return [];
    if (result.status !== 0) {
      throw new ProcessListUnavailable(pattern, new Error(`pgrep exit ${result.status}`));
    }
    pids = result.stdout
      .split('\n')
      .map(s => s.trim())
      .filter(s => s.length > 0)
      .map(s => parseInt(s, 10))
      .filter(n => !isNaN(n));
  } catch (err) {
    if (err instanceof ProcessListUnavailable) throw err;
    throw new ProcessListUnavailable(pattern, err);
  }

  if (pids.length === 0) return [];

  try {
    const psResult = spawnSync('ps', ['-o', 'pid=,command=', '-p', pids.join(',')], { encoding: 'utf-8' });
    if (psResult.error || psResult.status !== 0) {
      return pids.map(pid => ({ pid, command: '' }));
    }
    const lines = psResult.stdout.split('\n').filter(l => l.trim().length > 0);
    return lines.map(line => {
      const m = line.trim().match(/^(\d+)\s+(.*)$/);
      if (!m) return null;
      return { pid: parseInt(m[1]!, 10), command: m[2]!.trim() };
    }).filter((x): x is ProcessInfo => x !== null);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      // silent: ps failure already returns degraded result
    }
    return pids.map(pid => ({ pid, command: '' }));
  }
}
