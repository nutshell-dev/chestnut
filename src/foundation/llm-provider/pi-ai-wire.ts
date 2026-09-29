/**
 * @module L1.LLMProvider.PiAi
 *
 * chestnut wire 类型 → pi-ai Context 映射（Phase 1925 Step C，设计稿 D1.1）。
 *
 * - system：options.system 与 role:'system' 消息折叠进 systemPrompt；
 * - user：string | (TextContent)[]；
 * - assistant：text/thinking(含 signature)/tool_use → TextContent/ThinkingContent/ToolCall；
 *   config.dropThinkingBlocks 时剥离 thinking 块（MiniMax 等不支持回放的网关）；
 * - tool_result → ToolResultMessage：pi-ai 需要 toolName，chestnut wire 只有
 *   tool_use_id —— 从历史 assistant tool_use 块恢复 id→name（gemini formatter 同形
 *   先例），恢复失败回退 'tool'（协议层仅部分 api 使用 name）。
 */

import type * as PiAi from '@earendil-works/pi-ai';
import type {
  ContentBlock,
  LLMCallOptions,
  ProviderConfig,
  ProviderWireMessage,
  ToolDefinition,
} from './types.js';

/** 历史 assistant tool_use 块的 id→name 索引（tool_result 恢复用）。 */
function collectToolNames(messages: ProviderWireMessage[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== 'assistant' || typeof message.content === 'string') continue;
    for (const block of message.content) {
      if (block.type === 'tool_use') {
        names.set((block as { id: string }).id, (block as { name: string }).name);
      }
    }
  }
  return names;
}

function mapUserContent(content: ContentBlock[] | string): string | PiAi.TextContent[] {
  if (typeof content === 'string') return content;
  const blocks: PiAi.TextContent[] = [];
  for (const block of content) {
    if (block.type === 'text') {
      blocks.push({ type: 'text', text: (block as { text: string }).text });
    }
    // 非 text 块（tool_result 等）不走 user 路径；tool_result 单独成 ToolResultMessage
  }
  return blocks;
}

function mapAssistantContent(
  content: ContentBlock[] | string,
  dropThinkingBlocks: boolean,
): (PiAi.TextContent | PiAi.ThinkingContent | PiAi.ToolCall)[] {
  const blocks: (PiAi.TextContent | PiAi.ThinkingContent | PiAi.ToolCall)[] = [];
  if (typeof content === 'string') {
    if (content !== '') blocks.push({ type: 'text', text: content });
    return blocks;
  }
  for (const block of content) {
    if (block.type === 'text') {
      blocks.push({ type: 'text', text: (block as { text: string }).text });
    } else if (block.type === 'thinking') {
      if (dropThinkingBlocks) continue;
      const thinking = block as { thinking: string; signature?: string };
      blocks.push({
        type: 'thinking',
        thinking: thinking.thinking,
        ...(thinking.signature !== undefined && { thinkingSignature: thinking.signature }),
      });
    } else if (block.type === 'tool_use') {
      const toolUse = block as { id: string; name: string; input: Record<string, unknown> };
      blocks.push({
        type: 'toolCall',
        id: toolUse.id,
        name: toolUse.name,
        arguments: toolUse.input as PiAi.JsonObject,
      });
    }
    // UnknownBlock 静默忽略（协议无法表达的块不进请求）
  }
  return blocks;
}

function zeroUsage(): PiAi.Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/**
 * 组装 pi-ai Context。历史 assistant 消息的 api/provider/model/usage/stopReason
 * 为回放合成字段（协议只用 content 面）。
 */
export function buildPiAiContext(
  config: ProviderConfig,
  options: LLMCallOptions,
  model: PiAi.Model<PiAi.Api>,
): PiAi.Context {
  const toolNames = collectToolNames(options.messages);
  const systemParts: string[] = [];
  if (options.system) systemParts.push(options.system);

  const messages: PiAi.Message[] = [];
  const now = Date.now();
  for (const message of options.messages) {
    if (message.role === 'system') {
      const text = typeof message.content === 'string'
        ? message.content
        : message.content
            .filter((b) => b.type === 'text')
            .map((b) => (b as { text: string }).text)
            .join('\n');
      if (text !== '') systemParts.push(text);
      continue;
    }
    if (message.role === 'user') {
      if (typeof message.content !== 'string') {
        // tool_result 块独立成 ToolResultMessage（可与其他 text 块共存于同一 user 消息）
        const toolResults = message.content.filter((b) => b.type === 'tool_result');
        const rest = message.content.filter((b) => b.type !== 'tool_result');
        if (rest.length > 0) {
          messages.push({ role: 'user', content: mapUserContent(rest), timestamp: now });
        }
        for (const block of toolResults) {
          const tr = block as { tool_use_id: string; content: string; is_error?: boolean };
          messages.push({
            role: 'toolResult',
            toolCallId: tr.tool_use_id,
            toolName: toolNames.get(tr.tool_use_id) ?? 'tool',
            content: [{ type: 'text', text: tr.content }],
            isError: tr.is_error === true,
            timestamp: now,
          });
        }
      } else {
        messages.push({ role: 'user', content: message.content, timestamp: now });
      }
      continue;
    }
    // assistant
    messages.push({
      role: 'assistant',
      content: mapAssistantContent(message.content, config.dropThinkingBlocks === true),
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: zeroUsage(),
      stopReason: 'stop',
      timestamp: now,
    });
  }

  return {
    ...(systemParts.length > 0 && { systemPrompt: systemParts.join('\n\n') }),
    messages,
    ...(options.tools && options.tools.length > 0 && { tools: mapTools(options.tools) }),
  };
}

function mapTools(tools: ToolDefinition[]): PiAi.Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema as PiAi.TSchema,
  }));
}
