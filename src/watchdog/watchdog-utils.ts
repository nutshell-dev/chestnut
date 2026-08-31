/**
 * @module L6.Watchdog
 * @layer L6 进程边界（Watchdog 工具函数）
 * @depends L1.FileSystem, L2.AuditLog, L2.Stream
 * @consumers L6.Watchdog
 * @contract design/modules/l6_watchdog.md
 *
 * Phase 1396 Step H: crash/inactivity producer 退役后，本模块仅保留 stream
 * activity reader；contract/active 探测、snapshot、failure/crash taxonomy 均移除。
 */

import type { FileSystem } from '../foundation/fs/index.js';
import { isFileNotFound } from '../foundation/fs/index.js';
import type { AuditLog } from '../foundation/audit/index.js';
import { readAll, STREAM_FILE } from '../foundation/stream/index.js';
import { LLM_OUTPUT_EVENTS } from '../foundation/stream/index.js';
import { WATCHDOG_AUDIT_EVENTS } from './audit-events.js';
import { formatErr } from '../foundation/node-utils/index.js';

// Parse stream.jsonl, return the timestamp of the last event and the last error message
interface ClawActivityInfo {
  lastEventMs: number | null;  // most recent ts from any LLM output event
  lastError: string | null;    // error message when the last terminal event was turn_error
                               // only cleared by turn_end
}

export async function getClawActivityInfo(
  clawFs: FileSystem,
  audit: AuditLog,
): Promise<ClawActivityInfo> {
  try {
    const events = await readAll(clawFs, STREAM_FILE, audit);

    let lastEventMs: number | null = null;
    let lastError: string | null = null;

    for (const event of events) {
      const ts = typeof event.ts === 'number' ? event.ts : null;
      if (!ts) continue;

      // Direct LLM output counts as activity; turn_interrupted also counts
      // (claw was running but got interrupted — still an active state, not idle)
      if ((LLM_OUTPUT_EVENTS.has(event.type) || event.type === 'turn_interrupted') &&
          (lastEventMs === null || ts > lastEventMs)) {
        lastEventMs = ts;
      }

      // Only track terminal events to determine error state
      if (event.type === 'turn_end') {
        lastError = null;         // turn properly completed, clear error
      } else if (event.type === 'turn_error') {
        // String() 防御 / 任何 truthy 转 string / null → 'null' / undefined → 'undefined' / Error → message ('Error: xxx')
        lastError = event.error != null ? String(event.error) : 'unknown error';
      }
      // turn_interrupted: neither clear nor set error
    }

    return { lastEventMs, lastError };
  } catch (err) {
    if (!isFileNotFound(err)) {
      audit?.write(WATCHDOG_AUDIT_EVENTS.STREAM_READ_FAILED, `reason=${formatErr(err)}`);
    }
    return { lastEventMs: null, lastError: null };
  }
}
