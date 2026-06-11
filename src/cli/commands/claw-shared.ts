/**
 * @module L6.CLI.Claw.Shared
 * Helpers shared by listCommand + healthCommand
 */

import type { FileSystem } from '../../foundation/fs/types.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { readAll, STREAM_FILE, LLM_OUTPUT_EVENTS } from '../../foundation/stream/index.js';

/**
 * Format relative time (milliseconds to a human-readable string)
 */
export function formatRelativeTime(ms: number): string {
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return '<1m';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return `${hours}h`;
}

// LLM 输出事件类型（re-export from canonical stream module / single source per phase 1003）
export { LLM_OUTPUT_EVENTS };

/**
 * Format a hint message for caller when target claw is not running.
 *
 * @returns hint string with restart instruction, or undefined if claw is alive.
 * @example
 *   formatClawStatusHint('my-claw', false)
 *     === 'Note: claw "my-claw" is not running. Start it with: chestnut claw my-claw daemon'
 *   formatClawStatusHint('my-claw', true) === undefined
 */
export function formatClawStatusHint(clawName: string, isAlive: boolean): string | undefined {
  if (isAlive) return undefined;
  return `Note: claw "${clawName}" is not running. Start it with: chestnut claw ${clawName} daemon`;
}

/**
 * Format a hint message for caller when target claw has no active contract.
 *
 * Symmetric with `formatClawStatusHint`: accepts boolean param, returns undefined when contract exists.
 * @returns hint string asking to request reply via send tool, or undefined if there is an active contract.
 * @example
 *   formatNoActiveContractHint('my-claw', false)
 *     === 'No active contract for "my-claw". Ask claw to reply via send tool in message body.'
 *   formatNoActiveContractHint('my-claw', true) === undefined
 */
export function formatNoActiveContractHint(clawName: string, hasActiveContract: boolean): string | undefined {
  if (hasActiveContract) return undefined;
  return `No active contract for "${clawName}". Ask claw to reply via send tool in message body.`;
}

/**
 * 从 stream.jsonl 读取最后活跃时间（统一与 watchdog 指标）
 */
export async function getLastActiveMs(clawFs: FileSystem, audit: AuditLog): Promise<number | undefined> {
  try {
    const events = await readAll(clawFs, STREAM_FILE, audit);
    let last: number | undefined;
    for (const ev of events) {
      if (LLM_OUTPUT_EVENTS.has(ev.type) && typeof ev.ts === 'number') {
        last = ev.ts;
      }
    }
    return last;
  } catch { return undefined; }
}
