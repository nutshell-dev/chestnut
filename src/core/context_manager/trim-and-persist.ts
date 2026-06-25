/**
 * @module L4.ContextManager.TrimAndPersist
 * 事件性裁剪 + 持久化同源（phase 421 ratify、phase 440 实施）。
 */

import type { Message, ToolDefinition } from '../../foundation/llm-provider/index.js';
import type { DialogStore } from '../../foundation/dialog-store/index.js';
import { estimateTextTokens, estimateToolsTokens } from '../../foundation/llm-provider/index.js';
import { trimV2, type AuditWriter } from './trim-v2.js';
import { CONTEXT_TRIM_ARCHIVED } from './audit-events.js';

export type TriggerKind = 'reactive_overflow' | 'proactive_cache_idle';

export interface TrimAndPersistInputs {
  messages: Message[];
  systemPrompt: string;
  toolsForLLM: ToolDefinition[];
  contextWindow: number;
  recentWindowMs: number;
  targetRatio: number;
  previewBytes: number;
  filterSubtypes: ReadonlySet<string>;
  dialogStore: DialogStore;
  audit: AuditWriter;
  triggerKind: TriggerKind;
  now?: number;
}

export interface TrimAndPersistResult {
  newMessages: Message[];
  archived: boolean;
  estimatedTokensAfter: number;
}

/**
 * 事件性裁剪 + 持久化同源（phase 421 ratify、phase 440 实施）。
 *
 * 流程：
 * 1. 算 targetMessagesTokens = contextWindow × targetRatio - sysPromptTokens - toolsTokens
 * 2. 跑 trimV2（pure function、可 throw ContextTrimExhaustedError）
 * 3. DialogStore.archive() 备份 current.json
 * 4. DialogStore.save({systemPrompt, messages: newMessages, toolsForLLM})
 * 5. 返 newMessages 引用、caller 用此替换自身 messages 引用
 *
 * 异常路径：
 * - trimV2 throw ContextTrimExhaustedError → 不调 archive + save（保持 dialog 一致性）、上抛错
 * - archive 失败 → 不调 save、上抛错（caller decide failover）
 * - save 失败 → 上抛错、archive 已生效但 current.json 内容仍是旧版本（下次 load 走 archive fallback）
 */
export async function trimAndPersist(
  inputs: TrimAndPersistInputs,
): Promise<TrimAndPersistResult> {
  const now = inputs.now ?? Date.now();

  // 1. 算消息历史上限
  const targetMessagesTokens = Math.floor(inputs.contextWindow * inputs.targetRatio)
    - estimateTextTokens(inputs.systemPrompt)
    - estimateToolsTokens(inputs.toolsForLLM);

  // 2. 跑 trimV2（可 throw ContextTrimExhaustedError、上抛给 caller）
  const trimResult = trimV2(inputs.messages, {
    recentWindowMs: inputs.recentWindowMs,
    previewBytes: inputs.previewBytes,
    filterSubtypes: inputs.filterSubtypes,
    targetMessagesTokens,
    now,
    audit: inputs.audit,
  });

  // 3. archive 当前 current.json
  await inputs.dialogStore.archive();
  inputs.audit.write(
    CONTEXT_TRIM_ARCHIVED,
    `trigger_kind=${inputs.triggerKind}`,
  );

  // 4. save newMessages 替换 current.json
  await inputs.dialogStore.save({
    systemPrompt: inputs.systemPrompt,
    messages: trimResult.newMessages,
    toolsForLLM: inputs.toolsForLLM,
  });

  return {
    newMessages: trimResult.newMessages,
    archived: true,
    estimatedTokensAfter: trimResult.estimatedTokensAfter,
  };
}
