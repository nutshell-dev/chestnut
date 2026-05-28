/**
 * Base Anthropic Adapter
 * 
 * Abstract base class for Anthropic API compatible adapters.
 * Shared logic for message formatting and request body building.
 */

import type { ProviderConfig, LLMCallOptions, ProviderAdapter, StreamChunk } from './types.js';
import type { LLMResponse } from './types.js';
import { assertContentBlocks } from './_block-guards.js';
import { LLM_PROVIDER_AUDIT_EVENTS } from './audit-events.js';

export interface AnthropicRequestBody {
  model: string;
  messages: Array<{ role: string; content: string | unknown[] }>;
  max_tokens: number;
  temperature?: number;
  system?: string | Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }>;
  tools?: Array<{ name: string; description: string; input_schema: unknown; cache_control?: { type: 'ephemeral' } }>;
  thinking?: { type: 'enabled'; budget_tokens: number } | { type: 'adaptive'; effort: 'low' | 'medium' | 'high' };
}

export abstract class BaseAnthropicAdapter implements ProviderAdapter {
  abstract readonly name: string;
  abstract readonly model: string;
  protected abstract readonly config: ProviderConfig;

  abstract call(options: LLMCallOptions): Promise<LLMResponse>;
  abstract stream?(options: LLMCallOptions): AsyncIterableIterator<StreamChunk>;

  onStreamParseError?: (event: { provider: string; raw: string; error: string }) => void;

  protected get auditLog() {
    return this.config.auditLog;
  }

  protected get providerName(): string {
    return this.name;
  }

  /**
   * Build base request body without thinking section (subclasses add thinking).
   */
  protected buildBaseRequestBody(options: LLMCallOptions): AnthropicRequestBody {
    const { messages, system, tools, maxTokens, temperature } = options;
    const body: AnthropicRequestBody = {
      model: options.model ?? this.config.model,
      messages: this.formatMessages(messages),
      max_tokens: maxTokens ?? this.config.maxTokens,
    };

    if (system !== undefined) {
      body.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
    }

    if (temperature !== undefined) {
      body.temperature = temperature;
    } else if (this.config.temperature !== undefined) {
      body.temperature = this.config.temperature;
    }

    if (tools && tools.length > 0) {
      body.tools = tools.map((t, i) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
        ...(i === tools.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}),
      }));
    }

    return body;
  }

  /**
   * Format messages for Anthropic API
   * 
   * CRITICAL: This logic was refined through 5 iterations (hotfix #1, #2, #5).
   * DO NOT simplify to pass-through without understanding the consequences.
   * 
   * History:
   * - v1: Filter text only → lost tool blocks
   * - v2: Pass-through all → MiniMax rejected pure arrays for text-only messages
   * - v3: Conditional: tool blocks→array, text→string → correct
   * - v4 (Step 20): Pass-through all → REGRESSION: pure thinking blocks caused empty responses
   * - v5 (hotfix #5): Restore v3 logic with better comments
   * - v6: Add cache_control for prompt caching (last user message gets array with cache_control)
   * - v7 (phase 1274): Add orphan guard parity with openai formatter path
   * 
   * Requirements:
   * - Non-last user messages with pure text → string (MiniMax compatibility)
   * - Last user message → array with cache_control (prompt caching)
   * - Messages with tool_use/tool_result → must keep array format
   * - Messages with only thinking blocks → extract text, skip thinking blocks
   * 
   * Smart conversion:
   * - Non-last user message: string content → string
   * - Last user message: any format → array with cache_control on last block
   * - Assistant messages with tool blocks → array
   * - Text-only/think-only messages → extract text → string (unless last user)
   * 
   * This prevents pure think/thinking blocks from being sent to API without text,
   * which can cause empty responses from some LLM providers (e.g., MiniMax).
   * Cache_control on last user message enables incremental caching within a session.
   */
  protected formatMessages(messages: Array<{ role: string; content: unknown }>): Array<{ role: string; content: string | unknown[] }> {
    // Find last user message index for cache_control (同一会话内增量缓存)
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') { lastUserIdx = i; break; }
    }

    const dropThinking = this.config.dropThinkingBlocks ?? false;

    // NEW (phase 1274): accumulate prior assistant tool_use ids for orphan guard
    const priorToolCallIds = new Set<string>();

    return messages.flatMap((m, idx): Array<{ role: string; content: string | unknown[] }> => {
      const role = m.role === 'assistant' ? 'assistant' : 'user';
      const addCache = idx === lastUserIdx;

      // String content: add cache_control by converting to array
      if (!Array.isArray(m.content)) {
        if (addCache) {
          return [{ role, content: [{ type: 'text', text: m.content as string, cache_control: { type: 'ephemeral' } }] }];
        }
        return [{ role, content: m.content as string }];
      }

      assertContentBlocks(m.content);
      const blocks = m.content;

      // Filter thinking blocks if dropThinkingBlocks is enabled (for MiniMax and other providers)
      const effectiveBlocks = dropThinking
        ? blocks.filter(b => b.type !== 'thinking')
        : blocks;

      // NEW (phase 1274): Guard 3 — assistant content empty after filter → skip whole message
      if (role === 'assistant') {
        for (const b of effectiveBlocks) {
          if (b.type === 'tool_use' && typeof (b as { id?: unknown }).id === 'string' && (b as { id: string }).id) {
            priorToolCallIds.add((b as { id: string }).id);
          }
        }
        if (effectiveBlocks.length === 0) {
          this.auditLog?.write(
            LLM_PROVIDER_AUDIT_EVENTS.ASSISTANT_EMPTY_CONTENT_SKIPPED,
            `provider=${this.providerName}`,
            `reason=empty_after_filter`,
          );
          return [];
        }
      }

      // NEW (phase 1274): user path — filter tool_result blocks with empty-id + orphan guards
      let finalBlocks = effectiveBlocks;
      if (role === 'user') {
        const filtered: typeof effectiveBlocks = [];
        for (const b of effectiveBlocks) {
          if (b.type === 'tool_result') {
            const tuid = (b as { tool_use_id?: unknown }).tool_use_id;
            // Guard 1: empty id
            if (typeof tuid !== 'string' || !tuid) {
              this.auditLog?.write(
                LLM_PROVIDER_AUDIT_EVENTS.TOOL_RESULT_MISSING_ID,
                `provider=${this.providerName}`,
                `reason=tool_use_id_empty_or_undefined`,
              );
              continue;
            }
            // Guard 2: orphan
            if (!priorToolCallIds.has(tuid)) {
              this.auditLog?.write(
                LLM_PROVIDER_AUDIT_EVENTS.TOOL_RESULT_ORPHAN_ID,
                `provider=${this.providerName}`,
                `tool_use_id=${tuid}`,
                `reason=no_matching_assistant_tool_call`,
              );
              continue;
            }
          }
          filtered.push(b);
        }
        // NEW: skip whole user message if all blocks were filtered out
        if (filtered.length === 0 && effectiveBlocks.length > 0) {
          return [];
        }
        finalBlocks = filtered;
      }

      // Check if message contains structured blocks (tool_use, tool_result, or thinking)
      const hasStructuredBlocks = finalBlocks.some(
        b => b.type === 'tool_use' || b.type === 'tool_result' || b.type === 'thinking'
      );

      if (hasStructuredBlocks) {
        if (addCache) {
          // Copy last block with cache_control
          const copy: unknown[] = [...finalBlocks];
          copy[copy.length - 1] = { ...(copy[copy.length - 1] as Record<string, unknown>), cache_control: { type: 'ephemeral' } };
          return [{ role, content: copy }];
        }
        // Keep array format for structured messages
        return [{ role, content: finalBlocks }];
      }

      // Text-only or think-only
      const text = finalBlocks
        .filter((b): b is { type: 'text'; text?: string } => b.type === 'text')
        .map(b => b.text || '')
        .join('');

      // Skip messages that become empty after dropping thinking blocks.
      // This happens when an assistant message contained only thinking blocks.
      if (!text && !addCache) return [];

      if (addCache) {
        return [{ role, content: [{ type: 'text', text, cache_control: { type: 'ephemeral' } }] }];
      }
      return [{ role, content: text }];
    });
  }
}
