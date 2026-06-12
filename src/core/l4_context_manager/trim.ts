/**
 * @module L4.ContextManager
 * Context trim / pruning strategy
 *
 * Guarantees LLM API validity after trim:
 * - tool_use and tool_result must be paired (no orphans)
 * - turn boundary intact (do not cut inside a user turn)
 * - first user message must be preserved
 */

import type { Message } from '../../foundation/llm-provider/types.js';
import { estimateMessageTokens, estimateMessagesTokens } from '../../foundation/llm-provider/token-estimator.js';
import { ContextTrimExhaustedError } from './errors.js';
import {
  CONTEXT_TRIM_STARTED,
  CONTEXT_TRIM_COMPLETED,
  CONTEXT_TRIM_EXHAUSTED,
} from './audit-events.js';

/** Optional audit sink duck type */
export type AuditWriter = { write(event: string, ...details: string[]): void };

export interface TrimOptions {
  target: number;                       // target token count (≤ budget.available)
}

export interface TrimResult {
  messages: Message[];                  // trimmed messages (LLM API valid)
  droppedCount: number;
  estimatedTokensAfter: number;
}

/** Build map: assistant message index → user message index(s) that hold matching tool_result(s). */
function buildToolPairMap(messages: readonly Message[]): Map<number, number[]> {
  const map = new Map<number, number[]>();
  const toolUseIds = new Map<string, number>(); // tool_use_id -> assistant message index

  // First pass: collect all tool_use blocks and their message indices
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'assistant') continue;
    if (typeof msg.content === 'string') continue;
    for (const block of msg.content) {
      if (block.type === 'tool_use') {
        toolUseIds.set(block.id as string, i);
      }
    }
  }

  // Second pass: for each tool_result, map back to its tool_use message
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'user') continue;
    if (typeof msg.content === 'string') continue;
    for (const block of msg.content) {
      if ((block as { type?: string }).type === 'tool_result') {
        const assistantIdx = toolUseIds.get((block as { tool_use_id: string }).tool_use_id);
        if (assistantIdx !== undefined) {
          const list = map.get(assistantIdx) ?? [];
          list.push(i);
          map.set(assistantIdx, list);
        }
      }
    }
  }

  return map;
}

/** Find index of the first user message, or -1 if none. */
function findFirstUserIndex(messages: readonly Message[]): number {
  return messages.findIndex(m => m.role === 'user');
}

/**
 * Trim messages to fit within target token count.
 *
 * Invariants:
 * 1. tool_use/tool_result pairing: if an assistant message with tool_use is dropped,
 *    all user messages containing matching tool_result(s) are also dropped.
 * 2. Turn boundary: we drop whole messages (not partial content), preserving sequence validity.
 * 3. First user message is never dropped.
 * 4. droppedCount and estimatedTokensAfter are real values.
 */
export function trim(
  messages: Message[],
  systemPrompt: string,
  options: TrimOptions,
  auditWriter?: AuditWriter,
): TrimResult {
  void systemPrompt; // trim does not modify system prompt
  const { target } = options;

  // 1. Estimate current tokens
  let currentTokens = estimateMessagesTokens(messages);
  if (currentTokens <= target) {
    return {
      messages,
      droppedCount: 0,
      estimatedTokensAfter: currentTokens,
    };
  }

  auditWriter?.write(CONTEXT_TRIM_STARTED, `before=${currentTokens}`, `target=${target}`);

  // 2. Find first user message (must preserve)
  const firstUserIndex = findFirstUserIndex(messages);

  // 3. Build tool pairing map
  const toolPairs = buildToolPairMap(messages);

  const dropped = new Set<number>();

  // 4. Drop from oldest until we fit target or run out of trimmable messages
  for (let i = 0; i < messages.length; i++) {
    if (dropped.has(i)) continue;

    // Never drop the first user message
    if (i === firstUserIndex) continue;

    // Compute indices to drop: this message + any paired tool_results
    const indicesToDrop: number[] = [i];
    const paired = toolPairs.get(i);
    if (paired) {
      for (const pi of paired) {
        if (!dropped.has(pi)) {
          indicesToDrop.push(pi);
        }
      }
    }

    // Also, if this message is a user message containing tool_result(s),
    // check whether its paired assistant message is already dropped.
    // If not, we cannot drop this user message alone (would orphan tool_result).
    let canDrop = true;
    const msg = messages[i];
    if (msg.role === 'user' && typeof msg.content !== 'string') {
      for (const block of msg.content) {
        if ((block as { type?: string }).type === 'tool_result') {
          for (const [assistantIdx, resultIndices] of toolPairs.entries()) {
            if (resultIndices.includes(i) && !dropped.has(assistantIdx)) {
              canDrop = false;
              break;
            }
          }
          if (!canDrop) break;
        }
      }
    }

    if (!canDrop) continue;

    // Drop the messages
    for (const idx of indicesToDrop) {
      if (!dropped.has(idx)) {
        dropped.add(idx);
        currentTokens -= estimateMessageTokens(messages[idx]);
      }
    }

    if (currentTokens <= target) {
      break;
    }
  }

  // 5. If still over target after trimming
  if (currentTokens > target) {
    auditWriter?.write(CONTEXT_TRIM_EXHAUSTED, `after=${currentTokens}`, `target=${target}`);
    throw new ContextTrimExhaustedError(
      `Trim exhausted: ${currentTokens} > ${target}`
    );
  }

  // 6. Build result
  const remaining = messages.filter((_, i) => !dropped.has(i));
  const droppedCount = dropped.size;

  auditWriter?.write(CONTEXT_TRIM_COMPLETED, `after=${currentTokens}`, `dropped=${droppedCount}`);

  return {
    messages: remaining,
    droppedCount,
    estimatedTokensAfter: currentTokens,
  };
}
