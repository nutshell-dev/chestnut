/**
 * OpenAI request shape mappers — pure functions
 * 抽自 openai.ts (phase 630 / 形态 A.3 functional)
 * 0 this.X dep / 真 pure function
 */

import type { AuditLog } from '../audit/index.js';
import { LLM_PROVIDER_AUDIT_EVENTS } from './audit-events.js';


interface OpenAIMessage {
  role: string;
  content: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
}

interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: unknown;
  };
}

/**
 * Convert internal Message[] + system prompt → OpenAI messages array
 */
export function formatMessages(
  messages: Array<{ role: string; content: unknown }>,
  system?: string,
  auditLog?: AuditLog,
): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];

  // System message as first message
  if (system) {
    result.push({ role: 'system', content: system });
  }

  for (const m of messages) {
    const role = m.role;

    // Handle array content (tool_use, tool_result blocks)
    if (Array.isArray(m.content)) {
      const blocks = m.content as Array<Record<string, unknown>>;

      // Check for tool_use blocks (assistant)
      if (role === 'assistant') {
        const toolUses = blocks.filter(b => b.type === 'tool_use');
        if (toolUses.length > 0) {
          const textBlocks = blocks.filter(b => b.type === 'text') as Array<{ text?: string }>;
          const text = textBlocks.map(b => b.text || '').join('');

          result.push({
            role: 'assistant',
            content: text || '',
            tool_calls: toolUses.map(tu => ({
              id: tu.id as string,
              type: 'function',
              function: {
                name: tu.name as string,
                arguments: JSON.stringify(tu.input || {}),
              },
            })),
          });
          continue;
        }
      }

      // 收集 prior assistant.tool_calls id 集 (用于 cross-validate)
      const priorToolCallIds = new Set<string>();
      for (const prevMsg of result) {
        if (prevMsg.role === 'assistant' && Array.isArray(prevMsg.tool_calls)) {
          for (const tc of prevMsg.tool_calls as Array<{ id?: string }>) {
            if (typeof tc.id === 'string' && tc.id) priorToolCallIds.add(tc.id);
          }
        }
      }

      // Check for tool_result blocks (user/tool)
      const toolResults = blocks.filter(b => b.type === 'tool_result');
      for (const tr of toolResults) {
        const toolUseId = tr.tool_use_id;
        // Guard 1: tool_use_id 必须非空字符串
        if (typeof toolUseId !== 'string' || !toolUseId) {
          auditLog?.write(
            LLM_PROVIDER_AUDIT_EVENTS.TOOL_RESULT_MISSING_ID,
            `provider=openai`,
            `reason=tool_use_id_empty_or_undefined`,
            `content_preview=${(typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content)).slice(0, 80)}`,
          );
          continue; // skip 该 tool_result、不 emit 非法 message
        }
        // Guard 2: cross-validate prior assistant.tool_calls
        if (!priorToolCallIds.has(toolUseId)) {
          auditLog?.write(
            LLM_PROVIDER_AUDIT_EVENTS.TOOL_RESULT_ORPHAN_ID,
            `provider=openai`,
            `tool_use_id=${toolUseId}`,
            `reason=no_matching_assistant_tool_call`,
          );
          continue; // skip 孤儿 tool_result
        }
        result.push({
          role: 'tool',
          content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
          tool_call_id: toolUseId,
        });
      }

      // Regular text blocks
      const textBlocks = blocks.filter(b => b.type === 'text') as Array<{ text?: string }>;
      const text = textBlocks.map(b => b.text || '').join('');
      if (text || toolResults.length === 0) {
        result.push({ role: role === 'assistant' ? 'assistant' : 'user', content: text || '' });
      }
    } else {
      // String content
      result.push({
        role: role === 'assistant' ? 'assistant' : 'user',
        content: m.content as string,
      });
    }
  }

  return result;
}

/**
 * Convert tool definitions → OpenAI tools array
 */
export function formatTools(
  tools: Array<{ name: string; description: string; input_schema: unknown }>,
): OpenAITool[] {
  return tools.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}
