import { findByPattern } from '../process-exec/index.js';
import { PROCESS_MANAGER_AUDIT_EVENTS } from './audit-events.js';
import { ProcessListUnavailable } from './errors.js';
import type { ProcessManagerContext } from './types.js';
import type { ProcessInfo } from '../process-exec/types.js';

export function findProcesses(ctx: ProcessManagerContext, pattern: string): number[] {
  const escaped = pattern.replace(/[\\.^$*+?()[\]{}|]/g, '\\$&');
  let pids: number[];
  try {
    pids = findByPattern(escaped).map(p => p.pid);
  } catch (err) {
    if (err instanceof ProcessListUnavailable) {
      ctx.audit.write(
        PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_LIST_FAILED,
        `pattern=${pattern}`,
        `reason=${err.message}`,
      );
    }
    throw err;
  }
  return pids.filter(p => p !== process.pid);
}

/**
 * phase 346 B2 (review-2026-06-13): return full ProcessInfo (pid + cmdline) so
 * caller can apply stricter argv-token match than pgrep -f's regex-substring.
 * pgrep -f matches 'claw-a' inside 'claw-abc' →误杀 sibling claw。
 */
export function findProcessesDetailed(ctx: ProcessManagerContext, pattern: string): ProcessInfo[] {
  const escaped = pattern.replace(/[\\.^$*+?()[\]{}|]/g, '\\$&');
  let result: ProcessInfo[];
  try {
    result = findByPattern(escaped);
  } catch (err) {
    if (err instanceof ProcessListUnavailable) {
      ctx.audit.write(
        PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_LIST_FAILED,
        `pattern=${pattern}`,
        `reason=${err.message}`,
      );
    }
    throw err;
  }
  return result.filter(p => p.pid !== process.pid);
}

/**
 * phase 346 B2: tokenize a ps cmdline string and check if the token set contains
 * the given clawId as a distinct token (not substring). Handles space-separated
 * argv (POSIX `ps -o command`).
 */
export function commandContainsClawIdToken(command: string, clawId: string): boolean {
  if (!command) return false;
  // 简单按空白拆 argv 近似（ps 已 join、不还原 quoting 但 chestnut argv 无 spaces in clawId）
  const tokens = command.split(/\s+/).filter(t => t.length > 0);
  return tokens.includes(clawId);
}
