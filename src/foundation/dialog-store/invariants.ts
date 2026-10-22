/**
 * dialog messages 结构合法性 invariant。
 *
 * 应然 anchor（per design/modules/l2_dialog_store.md §「持久化 schema invariant」、phase 227）：
 * - DP1 信息不丢失：dialog 是权威持久档、保持其结构合法是 DP1 的最后一道闸门
 * - DP2 不静默丢弃：违例 emit audit 消除静默
 * - DP3/DP5 状态可观察 + 凭日志记录重建：违例显式可观察
 *
 * 不 throw（避免破坏 prod write 路径、Path #4 破坏论证）。
 */

import type { Message } from './canonical-message.js';
import type { DialogStoreAuditSink } from './audit-sink.js';
import { DIALOG_AUDIT_EVENTS } from './audit-events.js';

export function assertDialogShapeInvariants(
  messages: ReadonlyArray<Message> | undefined,
  audit: DialogStoreAuditSink,
): void {
  if (!Array.isArray(messages)) return;
  checkNoConsecutivePlainUserChat(messages, audit);
  checkToolUseResultPairing(messages, audit);
  checkToolUseResultAdjacency(messages, audit);
}

/**
 * 不变量 1：连续 ≥ 2 条 plain user chat 消息几乎不可能合法。
 *
 * "plain user chat" 定义 = role:'user' 且 content 是 string 或 content 是 array 但不含 tool_result block。
 * tool_result 包装的 user 块是正常 ReAct 循环、不算 plain user chat。
 *
 * phase 224 bug 实证：trim 引用分裂下 user 消息累积而 assistant 不 push、即触本不变量。
 */
function checkNoConsecutivePlainUserChat(
  messages: ReadonlyArray<Message>,
  audit: DialogStoreAuditSink,
): void {
  for (let i = 1; i < messages.length; i++) {
    const prev = messages[i - 1];
    const curr = messages[i];
    if (prev.role === 'user' && curr.role === 'user'
        && isPlainUserChat(prev) && isPlainUserChat(curr)) {
      audit.write(
        DIALOG_AUDIT_EVENTS.DIALOG_INVARIANT_VIOLATED,
        `kind=consecutive_plain_user_chat`,
        `prev_idx=${i - 1}`,
        `curr_idx=${i}`,
        `messages_length=${messages.length}`,
      );
      return; // 单次违例 emit 一次即可、避免 N 连续 user chat 时刷 audit
    }
  }
}

function isPlainUserChat(m: Message): boolean {
  if (m.role !== 'user') return false;
  if (typeof m.content === 'string') return true;
  if (Array.isArray(m.content)) {
    return !m.content.some((b: unknown) =>
      typeof b === 'object' && b !== null && (b as { type?: string }).type === 'tool_result'
    );
  }
  return false;
}

/**
 * 不变量 2：assistant 块内每个 tool_use block 在同 messages 数组内必有对应 tool_result（按 tool_use_id 配对）。
 *
 * 配对 scope = 整 messages 数组（不限同 turn 内）。trim 触发 / 中断恢复路径都可能让 pair 跨 boundary、所以全数组扫。
 */
function checkToolUseResultPairing(
  messages: ReadonlyArray<Message>,
  audit: DialogStoreAuditSink,
): void {
  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();
  const toolUsePositions = new Map<string, number>(); // id → message index
  const orderViolations = new Set<string>();

  // phase 918: first pass — record every tool_use position so we can detect
  // tool_result blocks that appear BEFORE their paired tool_use.
  for (let mi = 0; mi < messages.length; mi++) {
    const content = messages[mi].content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue;
      const b = block as { type?: string; id?: string; tool_use_id?: string };
      if (b.type === 'tool_use' && typeof b.id === 'string') {
        toolUseIds.add(b.id);
        // Keep the earliest occurrence (defensive; normally one tool_use per id)
        if (!toolUsePositions.has(b.id)) {
          toolUsePositions.set(b.id, mi);
        }
      }
    }
  }

  // Second pass — collect tool_result ids and check order.
  for (let mi = 0; mi < messages.length; mi++) {
    const content = messages[mi].content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue;
      const b = block as { type?: string; id?: string; tool_use_id?: string };
      if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        toolResultIds.add(b.tool_use_id);
        // phase 918: tool_result must appear AFTER its paired tool_use
        const usePos = toolUsePositions.get(b.tool_use_id);
        if (usePos !== undefined && mi < usePos && !orderViolations.has(b.tool_use_id)) {
          orderViolations.add(b.tool_use_id);
          audit.write(
            DIALOG_AUDIT_EVENTS.DIALOG_INVARIANT_VIOLATED,
            `kind=tool_result_before_tool_use`,
            `tool_use_id=${b.tool_use_id}`,
            `tool_use_idx=${usePos}`,
            `tool_result_idx=${mi}`,
            `messages_length=${messages.length}`,
          );
        }
      }
    }
  }

  // 孤悬 tool_use（无 tool_result 配对）
  for (const id of toolUseIds) {
    if (!toolResultIds.has(id)) {
      audit.write(
        DIALOG_AUDIT_EVENTS.DIALOG_INVARIANT_VIOLATED,
        `kind=orphan_tool_use`,
        `tool_use_id=${id}`,
        `messages_length=${messages.length}`,
      );
    }
  }

  // 孤悬 tool_result（无 tool_use 配对）
  for (const id of toolResultIds) {
    if (!toolUseIds.has(id)) {
      audit.write(
        DIALOG_AUDIT_EVENTS.DIALOG_INVARIANT_VIOLATED,
        `kind=orphan_tool_result`,
        `tool_use_id=${id}`,
        `messages_length=${messages.length}`,
      );
    }
  }
}

/**
 * 不变量 3：tool_result 必须紧邻其 assistant tool_use（Phase 1970）。
 *
 * 从 assistant 的下一条开始，在连续 user 消息中收集匹配 tool_result，
 * 直到 pending 清空。若中途遇到 role != user，或一条不含任何匹配
 * tool_result 的 user 消息（纯文本摘要即此类），则邻接断裂并 emit。
 *
 * 纯缺失（扫到数组末尾仍未配对）不在此 emit——由不变量 2 的
 * orphan_tool_use 定性，避免同一事实双重归因。
 */
function checkToolUseResultAdjacency(
  messages: ReadonlyArray<Message>,
  audit: DialogStoreAuditSink,
): void {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;

    const pending = new Set<string>();
    for (const block of msg.content) {
      const b = block as { type?: string; id?: string };
      if (b.type === 'tool_use' && typeof b.id === 'string' && b.id) pending.add(b.id);
    }
    if (pending.size === 0) continue;

    for (let j = i + 1; j < messages.length && pending.size > 0; j++) {
      const next = messages[j];
      if (next.role !== 'user' || !Array.isArray(next.content)) {
        emitToolUseResultNotAdjacent(audit, pending, i, j, messages.length);
        break;
      }

      let matched = 0;
      for (const block of next.content) {
        const b = block as { type?: string; tool_use_id?: string };
        if (b.type === 'tool_result'
            && typeof b.tool_use_id === 'string'
            && pending.delete(b.tool_use_id)) {
          matched++;
        }
      }
      if (pending.size > 0 && matched === 0) {
        emitToolUseResultNotAdjacent(audit, pending, i, j, messages.length);
        break;
      }
    }
  }
}

function emitToolUseResultNotAdjacent(
  audit: DialogStoreAuditSink,
  pending: ReadonlySet<string>,
  toolUseIdx: number,
  nextIdx: number,
  messagesLength: number,
): void {
  for (const id of pending) {
    audit.write(
      DIALOG_AUDIT_EVENTS.DIALOG_INVARIANT_VIOLATED,
      `kind=tool_use_result_not_adjacent`,
      `tool_use_id=${id}`,
      `tool_use_idx=${toolUseIdx}`,
      `next_idx=${nextIdx}`,
      `messages_length=${messagesLength}`,
    );
  }
}
