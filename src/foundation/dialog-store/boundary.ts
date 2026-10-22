/**
 * DialogStore message-structure boundary query（Phase 1970 Step C）。
 *
 * 返回把一条 user 消息插入 messages 的最近安全位置：不落在任一
 * assistant tool_use 与其 tool_result 之间。未配对 tool_use 视为延伸到数组
 * 末尾的开放 span，避免摘要被追加成伪 tool 响应。
 *
 * 纯查询：不修改 messages、不写 audit、不做修复。
 */

import type { Message } from './canonical-message.js';

export function findToolPairSafeInsertionIndex(
  messages: readonly Message[],
  candidate: number,
): number {
  const clamped = Math.max(0, Math.min(candidate, messages.length));

  const toolUsePos = new Map<string, number>();
  const resultPos = new Map<string, number>();
  for (let i = 0; i < messages.length; i++) {
    const content = messages[i].content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type === 'tool_use' && typeof block.id === 'string') {
        toolUsePos.set(block.id, i);
      } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        resultPos.set(block.tool_use_id, i);
      }
    }
  }

  const spans: Array<{ start: number; end: number }> = [];
  for (const [id, start] of toolUsePos) {
    spans.push({ start, end: resultPos.get(id) ?? messages.length });
  }

  let index = clamped;
  let moved = true;
  while (moved) {
    moved = false;
    for (const span of spans) {
      if (index > span.start && index <= span.end) {
        index = span.start;
        moved = true;
      }
    }
  }
  return index;
}
