/**
 * @module L2b.DialogStore.Repair
 * 消息修复 — 修剪 trailing unpaired tool_use 等场景。
 *
 * 抽出自 store.ts、dialogstore-auditor §M-01 follow-up（SRP 拆分）。
 */

import type { Message, ToolUseBlock, ToolResultBlock } from '../llm-provider/types.js';

/**
 * Repair messages — 移除 trailing unpaired tool_use blocks 等。
 * Pure function、无 instance state。
 */
export function repairMessages(
  messages: Message[],
  opts?: { interruptionMessage?: string },
): { repaired: Message[]; toolCount: number } {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant') return { repaired: messages, toolCount: 0 };

  const content = Array.isArray(last.content) ? last.content : null;
  if (!content) return { repaired: messages, toolCount: 0 };
  const toolUseBlocks = content.filter(
    (b): b is ToolUseBlock => b.type === 'tool_use'
  );
  if (toolUseBlocks.length === 0) return { repaired: messages, toolCount: 0 };

  const detail = opts?.interruptionMessage && opts.interruptionMessage.trim().length > 0
    ? opts.interruptionMessage
    : 'Cause unknown (no context provided to repair).';

  const syntheticResults: ToolResultBlock[] = toolUseBlocks.map(block => {
    let inputDesc: string;
    try {
      inputDesc = JSON.stringify(block.input);
    } catch {
      // silent: cyclic reference guard — fallback to unserializable placeholder
      inputDesc = '<unserializable>';
    }
    return {
      type: 'tool_result',
      tool_use_id: block.id,
      content: `Tool call '${block.name}' with input ${inputDesc} was interrupted. ${detail}`,
      is_error: true,
    };
  });

  return {
    repaired: [...messages, { role: 'user', content: syntheticResults }],
    toolCount: toolUseBlocks.length,
  };
}
