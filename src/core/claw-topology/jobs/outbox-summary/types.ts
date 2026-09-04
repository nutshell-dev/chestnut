/**
 * @module L4.ClawTopology.OutboxSummary
 * phase 1476: state schema for outbox unread summary scan.
 *
 * 业主 own facts + state schema (M#2 + M#5):
 * - 仅 own claw outbox/pending 计数 + 文件身份
 * - 不知 motion CLI / 不预设 guidance 字面（归 Assembly composer）
 * - wire metadata 由 owner codec（guidance-state.ts, phase 1259）独占产出
 */

export const PREVIEW_MAX_CHARS = 40 as const;

/**
 * phase 1757 Step B: 重复推送逐 claw outbox-skip 指引的渲染 port。
 * core 只声明此中性 callback 签名（clawId → 指引行文本），不知道 CLIProtocol
 * 路径、`CliGuidanceAction` 或任何 CLI 字面；最终 invocation 由 CLI/Assembly
 * 层在边界注入实现渲染（src/assembly/motion-addons.ts 经 renderCliGuidanceAction）。
 */
export type RenderOutboxSkipHint = (clawId: string) => string;

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
  /** phase 938 NEW: clawIds whose outbox I/O failed during scan. */
  failed_claws: string[];
  /** phase 938 NEW: true if any claw failed to scan (hash/counts may be incomplete). */
  incomplete: boolean;
}
