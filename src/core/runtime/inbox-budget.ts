/**
 * @module L4.Runtime.InboxBudget
 * Phase 1967 Step B: inbox 注入预算与轮转选择。
 *
 * derivation: 1939 现场 85 条整批注入；20 条 / 64KiB 为 1939 拍板上限，
 * 1940 D3 要求预算按**最终格式化表示**（注入 Message 的 JSON 字节）计量。
 *
 * 职责边界：本模块只提供预算常量、稳定排序与字节测量纯函数；
 * 选择决策在 Runtime.formatPreparedInbox（格式化边界），defer 事实操作在
 * Messaging（InboxReader.defer），disposition 编排在 EventLoop。三层不混。
 */

import type { Message } from '../../foundation/dialog-store/index.js';
import { PRIORITY_ORDER } from '../../foundation/messaging/index.js';
import type { PreparedInboxEntry } from './types.js';

/** 单轮注入条数上限（1939 拍板）。 */
export const INBOX_BATCH_MAX_ITEMS = 20;
/** 单轮注入格式化字节上限（1939 拍板，按最终格式化表示计量）。 */
export const INBOX_BATCH_MAX_FORMATTED_BYTES = 64 * 1024;

export interface InboxFormatBudget {
  readonly maxItems: number;
  readonly maxFormattedBytes: number;
}

export const DEFAULT_INBOX_FORMAT_BUDGET: InboxFormatBudget = {
  maxItems: INBOX_BATCH_MAX_ITEMS,
  maxFormattedBytes: INBOX_BATCH_MAX_FORMATTED_BYTES,
};

/**
 * 稳定 priority→age 排序：critical→high→normal→low，同 priority 按 timestamp
 * 升序；同 priority/timestamp 保持 prepareInbox 原顺序（ES stable sort）。
 * 不 mutate 输入。
 */
export function orderInboxEntries(
  entries: readonly PreparedInboxEntry[],
): PreparedInboxEntry[] {
  return [...entries].sort((a, b) =>
    PRIORITY_ORDER.indexOf(a.message.priority) - PRIORITY_ORDER.indexOf(b.message.priority)
    || Date.parse(a.message.timestamp) - Date.parse(b.message.timestamp));
}

/**
 * 1940 D3: 预算计量对象 = 最终注入的 Message 的 JSON 序列化字节（UTF-8），
 * 不是原始正文长度。
 */
export function formattedMessageBytes(message: Message): number {
  return Buffer.byteLength(JSON.stringify(message), 'utf8');
}
