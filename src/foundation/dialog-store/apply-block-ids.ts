/**
 * @module L2b.DialogStore
 *
 * phase 1850 Step C: save() 不再隐式写 caller 传入的 messages——blockId 在 owner 内
 * clone 上分配、经 `DialogSaveResult.assignedBlockIds` 显式回传；需要 in-memory
 * blockId 的 caller（如 trim-v2 折叠占位符 `block-id=<short>` 消费链）用本原语把
 * assignments 写回自己持有的数组。
 *
 * 语义：按 (messageIndex, blockIndex) 定位写回；越界 / string content / 目标块
 * 已带 blockId 一律跳过（不覆盖既有 ID）；空 assignments 为 no-op。
 */

import type { Message } from './canonical-message.js';
import type { BlockIdAssignment } from './types.js';

export function applyBlockIdAssignments(
  messages: Message[],
  assignments: readonly BlockIdAssignment[],
): void {
  for (const a of assignments) {
    const msg = messages[a.messageIndex];
    if (!msg || typeof msg.content === 'string') continue;
    const block = msg.content[a.blockIndex] as Record<string, unknown> | undefined;
    if (!block || block.blockId !== undefined) continue;     // 不覆盖既有 ID
    block.blockId = a.blockId;
  }
}
