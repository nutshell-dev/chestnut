/**
 * SNAPSHOT_IGNORE_PATTERNS aggregation point.
 *
 * Owns the cross-module ignore policy for code snapshots.
 * phase 157: moved from src/assembly/snapshot-patterns.ts (M#1/#3 true ownership, snapshot module owns)
 *
 * 应然 anchor:
 * - M#1 patterns are a snapshot module business concept, independently variable from assembly concerns
 * - M#3 resource single ownership: patterns belong to the snapshot module
 * - M#9 explicit expression: physical path reflects layer ownership (foundation/snapshot/)
 *
 * phase 936 r114+ Cluster 3 site #1 β-inject landed
 * phase 157 α true ownership: moved to foundation/snapshot/patterns.ts
 */
import { STREAM_FILE } from '../stream/index.js';
import { AUDIT_FILE } from '../audit/index.js';

export const SNAPSHOT_IGNORE_PATTERNS: readonly string[] = [
  STREAM_FILE,
  AUDIT_FILE,
  'tasks/queues/',                  // phase 513 / full queues subtree (pending/running/done/failed/results) / queue state ephemeral / not committed
  'tasks/sync/',
  'tasks/subagents/',               // phase 512 / subagent workspace ephemeral / not committed (TASKS_SUBAGENTS_DIR literal)
];
