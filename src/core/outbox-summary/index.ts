/**
 * @module L4.OutboxSummary
 * phase 1476: pull-model outbox unread summary 业主.
 * phase 42: 重构走 Messaging 入口（InboxWriter / InboxReader / OutboxReader）。
 *
 * 业务：每 cron tick 扫所有 claws/*\/outbox/pending → 若 unread > 0 + 新版本 → 写
 * dedup 后的 summary 到 motion/inbox/pending（让 motion 自决何时 CLI 拉取查 outbox 具体内容）.
 *
 * 应然 anchor：DP「事件驱动恰好交付」+ Philosophy「系统为智能体服务」+ ML#2 业务语义自负
 * + ML#5 不预设上层 CLI（guidance 字面归 Assembly composer）.
 *
 * Design：design/modules/l4_outbox_summary.md §1-3 + §7.B.
 */

export { runOutboxSummaryTick } from './tick.js';
export type { OutboxSummaryTickDeps } from './tick.js';
export type { OutboxSummaryState } from './types.js';
export { toExtraMeta } from './types.js';
export { computeHash, HASH_LEN } from './hash.js';
export { scanOutboxes } from './scan.js';
export { findExistingSummaryByHash, DEDUP_DONE_WINDOW_MS, SUMMARY_HASH_META_KEY } from './dedup.js';
export { writeNewSummary, SUMMARY_INBOX_TYPE } from './write.js';
