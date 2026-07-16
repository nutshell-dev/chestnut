/**
 * @module L4.ContextManager.MaybeTrimProactive
 * 顺手裁触发：turn 入口判断「占用率 ≥ 0.75 AND 缓存已失效」、满足则调 trimAndPersist。
 */

import type { Message, ToolDefinition } from '../../foundation/llm-provider/index.js';
import type { DialogStore } from '../../foundation/dialog-store/index.js';
import {
  estimateTextTokens,
  estimateMessagesTokens,
  estimateToolsTokens,
} from '../../foundation/llm-provider/token-estimator.js';
import { trimAndPersist, type TrimAndPersistResult } from './trim-and-persist.js';
import {
  CACHE_TTL_MS,
  CONTEXT_TRIM_RECENT_WINDOW_MS,
  CONTEXT_TRIM_TARGET_RATIO,
  CONTEXT_TRIM_PREVIEW_BYTES,
} from './constants.js';
import { ContextTrimExhaustedError } from './errors.js';
import { CONTEXT_TRIM_EXHAUSTED } from './audit-events.js';
import type { AuditWriter } from './trim-v2.js';

export interface MaybeTrimProactiveInputs {
  messages: Message[];
  systemPrompt: string;
  toolsForLLM: ToolDefinition[];
  contextWindow: number;

  /** 上次 LLM 调用完成时刻 (ms epoch)；0 = 从未调用过 */
  lastLLMCallAt: number;

  filterSubtypes: ReadonlySet<string>;
  dialogStore: DialogStore;
  audit: AuditWriter;

  /** 注入测试用、默认 Date.now() */
  now?: number;
}

/**
 * 顺手裁触发：turn 入口判断「占用率 ≥ 0.75 AND 缓存已失效」、满足则调 trimAndPersist。
 *
 * 触发条件（4 件全满足）：
 * 1. 非首次（lastLLMCallAt !== 0）
 * 2. 缓存已失效（Date.now() - lastLLMCallAt > CACHE_TTL_MS）
 * 3. 占用率 ≥ 0.75（estimateMessagesTokens ≥ targetMessagesTokens）
 * 4. dialogStore 可用（caller 已提供）
 *
 * 不触发返 null；触发则返 TrimAndPersistResult（含 newMessages 引用、caller 替换自身引用）。
 */
export async function maybeTrimProactive(
  inputs: MaybeTrimProactiveInputs,
): Promise<TrimAndPersistResult | null> {
  const now = inputs.now ?? Date.now();

  // 1. 首次不触发
  if (inputs.lastLLMCallAt === 0) return null;

  // 2. 缓存未失效不触发
  if (now - inputs.lastLLMCallAt <= CACHE_TTL_MS) return null;

  // 3. 算 targetMessagesTokens（同 trimAndPersist 内部公式）
  const targetMessagesTokens = Math.floor(inputs.contextWindow * CONTEXT_TRIM_TARGET_RATIO)
    - estimateTextTokens(inputs.systemPrompt)
    - estimateToolsTokens(inputs.toolsForLLM);

  // 4. 占用率 < 0.75 不触发
  const estimatedTokens = estimateMessagesTokens(inputs.messages);
  if (estimatedTokens < targetMessagesTokens) return null;

  // 5. 触发顺手裁
  try {
    return await trimAndPersist({
      messages: inputs.messages,
      systemPrompt: inputs.systemPrompt,
      toolsForLLM: inputs.toolsForLLM,
      contextWindow: inputs.contextWindow,
      recentWindowMs: CONTEXT_TRIM_RECENT_WINDOW_MS,
      targetRatio: CONTEXT_TRIM_TARGET_RATIO,
      previewBytes: CONTEXT_TRIM_PREVIEW_BYTES,
      filterSubtypes: inputs.filterSubtypes,
      dialogStore: inputs.dialogStore,
      audit: inputs.audit,
      triggerKind: 'proactive_cache_idle',
      now,
    });
  } catch (err) {
    if (err instanceof ContextTrimExhaustedError) {
      inputs.audit.write(CONTEXT_TRIM_EXHAUSTED,
        `trigger=proactive`,
        `reason=${err.message}`,
      );
      return null;
    }
    throw err;
  }
}
