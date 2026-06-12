/**
 * @module L4.OutboxSummary
 * phase 1476: state schema for outbox unread summary scan.
 *
 * 业主 own facts + state schema (M#2 + M#5):
 * - 仅 own claw outbox/pending 计数 + 文件身份
 * - 不知 motion CLI / 不预设 guidance 字面（归 Assembly composer）
 * - Assembly composer 经 Runtime extraMeta 接 stringified 字段
 */

export const PREVIEW_MAX_CHARS = 40 as const;

/** Output of one outbox-summary scan tick. */
export interface OutboxSummaryState {
  /** Map clawId → unread file count (only claws with > 0 unread are present). */
  counts: Record<string, number>;
  /** Number of claws with unread messages (== Object.keys(counts).length). */
  total_claws: number;
  /** Total unread messages across all claws (== sum(counts values)). */
  total_msgs: number;
  /** Sorted list of "<clawId>:<filename>" entries (file身份). */
  file_set: string[];
  /**
   * Dedup hash = SHA256(file_set.join('\n')).slice(0, 12).
   * Changes iff fileSet (added/removed/swapped msg) changes.
   * 同 count 不同 msg → 不同 hash（user 2026-05-30 ratify by phase 1476 anti-pattern #2）.
   */
  hash: string;
  /** phase 44 NEW: truncated preview of the latest unread message per claw. */
  previews: Record<string, string>;
}

/** Per-tick state for guidance extraMeta（Record<string,string> only / serialized）. */
export function toExtraMeta(state: OutboxSummaryState): Record<string, string> {
  return {
    hash: state.hash,
    total_claws: String(state.total_claws),
    total_msgs: String(state.total_msgs),
    counts: JSON.stringify(state.counts),
  };
}
