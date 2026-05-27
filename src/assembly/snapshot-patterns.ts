/**
 * SNAPSHOT_IGNORE_PATTERNS aggregation point.
 *
 * Owns the cross-module ignore policy for code snapshots.
 * Aggregated here (L6 assembly) instead of L2 foundation/snapshot
 * so L2 Snapshot module 0 L4 const import.
 *
 * 应然 anchor:
 * - A.7 应然原意「Assembly 聚合 ignore patterns + Snapshot 不内化字面量」（phase 150+）
 * - ML#5 模块依赖单向（L2 0 L4 import）
 * - ML#9 不可消除耦合显式表达（assembly 装配期单点聚合三方耦合）
 *
 * phase 936 r114+ Cluster 3 site #1 β-inject 落地
 */
import { STREAM_FILE } from '../foundation/stream/index.js';
import { AUDIT_FILE } from '../foundation/audit/index.js';
import { TASKS_SUBAGENTS_DIR } from '../core/async-task-system/index.js';

export const SNAPSHOT_IGNORE_PATTERNS: readonly string[] = [
  STREAM_FILE,
  AUDIT_FILE,
  'tasks/queues/',                  // phase 513 / 全 queues 子树（含 pending/running/done/failed/results）/ queue state ephemeral / 不进 commit
  'tasks/sync/',
  `${TASKS_SUBAGENTS_DIR}/`,        // phase 512 / subagent workspace ephemeral / 不进 commit
];
