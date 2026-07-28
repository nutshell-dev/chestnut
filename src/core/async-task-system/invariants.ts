/**
 * async-task save 入口 schema invariant。
 *
 * 应然 anchor（per design/modules/l4_async_task_system.md §「persist-state observability」、phase 239）：
 * - DP1 信息不丢失：pending/running 磁盘是 task 权威态、save 入口守 schema 合法是 DP1 最后一道闸门
 * - DP2 不静默丢弃：违例 emit audit 消除静默
 * - DP3/DP5 状态可观察 + 凭日志记录重建：违例显式可观察
 *
 * 与 `task-corrupt-helpers.ts:validateTaskShape` load 端 check 对称：
 * - load 端：`validateTaskShape` 用 `TaskSchema.safeParse` → 违例 backupCorruptTask + audit
 * - save 端（本模块）：用 `TaskSchema.safeParse` → 违例 emit audit、不 throw、不 isolate（Path #4 防 break）
 *
 * 复用 `task-schemas.ts:TaskSchema` Zod SoT、不重复定义 schema。
 */

import type { AuditLog } from '../../foundation/audit/index.js';
import { TASK_AUDIT_EVENTS } from './audit-events.js';
import { TaskSchema } from './task-schemas.js';

export type SaveSource = 'schedule_subagent' | 'schedule_tool' | 'schedule_prepared';

export function assertTaskShapeOnSave(
  task: unknown,
  audit: AuditLog,
  source: SaveSource,
): void {
  const result = TaskSchema.safeParse(task);
  if (result.success) return;

  const taskId = extractTaskId(task);
  const errSummary = summarizeZodErrors(result.error);

  audit.write(
    TASK_AUDIT_EVENTS.ASYNC_TASK_INVARIANT_VIOLATED,
    `task_id=${taskId}`,
    `source=${source}`,
    `zod_errors=${errSummary}`,
  );
}

function extractTaskId(task: unknown): string {
  if (typeof task === 'object' && task !== null && 'id' in task) {
    const id = (task as { id?: unknown }).id;
    if (typeof id === 'string') return id;
  }
  return 'unknown';
}

function summarizeZodErrors(err: { errors: Array<{ path: (string | number)[]; message: string; code?: string; unionErrors?: Array<{ errors: Array<{ path: (string | number)[]; message: string }> }> }> }): string {
  // 扁平化收集 issues（含 union 嵌套）、最多列前 3 个、防止 audit row 过长
  // union 错误时：取 issue list 最短的分支（最可能接近真实类型）
  const issues: Array<{ path: (string | number)[]; message: string }> = [];
  for (const e of err.errors) {
    if (e.code === 'invalid_union' && e.unionErrors && e.unionErrors.length > 0) {
      const best = [...e.unionErrors].sort((a, b) => a.errors.length - b.errors.length)[0];
      for (const ie of best.errors) {
        issues.push(ie);
        if (issues.length >= 3) break;
      }
    } else {
      issues.push(e);
    }
    if (issues.length >= 3) break;
  }
  return issues.slice(0, 3).map(e => `${e.path.join('.')}=${e.message}`).join('|');
}
