/**
 * @module L4.ContextManager.TrimAndPersist
 * 事件性裁剪 + 持久化同源（phase 421 ratify、phase 440 实施、phase 1153 区分 proactive/reactive）。
 */

import type { Message, ToolDefinition } from '../../foundation/llm-provider/index.js';
import type { DialogStore } from '../../foundation/dialog-store/index.js';
import {
  estimateTextTokens,
  estimateToolsTokens,
} from '../../foundation/llm-provider/token-estimator.js';
import { trimV2, type AuditWriter, type TrimPolicy, type ContextTrimOutcome } from './trim-v2.js';
import { CONTEXT_TRIM_ARCHIVED } from './audit-events.js';

export type TriggerKind = 'reactive_overflow' | 'proactive_cache_idle';

export interface TrimAndPersistInputs {
  messages: Message[];
  systemPrompt: string;
  toolsForLLM: ToolDefinition[];
  contextWindow: number;
  recentWindowMs: number;
  previewBytes: number;
  filterSubtypes: ReadonlySet<string>;
  dialogStore: DialogStore;
  audit: AuditWriter;
  triggerKind: TriggerKind;
  policy: TrimPolicy;
  now?: number;
}

/**
 * 事件性裁剪 + 持久化同源。
 *
 * 流程：
 * 1. 跑 trimV2（pure function、返回 discriminated outcome）
 * 2. no_progress / policy_conflict → 不持久化，直接返回 outcome
 * 3. target_reached / progress → DialogStore.archive() 备份 current.json
 * 4. DialogStore.save({systemPrompt, messages: newMessages, toolsForLLM})
 * 5. 返回 outcome + archived=true
 *
 * 异常路径：
 * - archive 失败 → 不调 save、上抛错（caller decide failover）
 * - save 失败 → 上抛错、archive 已生效但 current.json 内容仍是旧版本（下次 load 走 archive fallback）
 */
export async function trimAndPersist(
  inputs: TrimAndPersistInputs,
): Promise<ContextTrimOutcome> {
  const now = inputs.now ?? Date.now();

  const fixedTokens = estimateTextTokens(inputs.systemPrompt)
    + estimateToolsTokens(inputs.toolsForLLM);

  const result = trimV2(inputs.messages, {
    recentWindowMs: inputs.recentWindowMs,
    previewBytes: inputs.previewBytes,
    filterSubtypes: inputs.filterSubtypes,
    fixedTokens,
    policy: inputs.policy,
    now,
    audit: inputs.audit,
  });

  const outcome = result.outcome;

  if (outcome.status === 'no_progress' || outcome.status === 'policy_conflict') {
    return { ...outcome, archived: false };
  }

  if (outcome.after >= outcome.before) {
    throw new Error(`invalid trim progress: ${outcome.after} >= ${outcome.before}`);
  }

  await inputs.dialogStore.archive();
  inputs.audit.write(
    CONTEXT_TRIM_ARCHIVED,
    `trigger_kind=${inputs.triggerKind}`,
  );

  await inputs.dialogStore.save({
    systemPrompt: inputs.systemPrompt,
    messages: outcome.newMessages,
    toolsForLLM: inputs.toolsForLLM,
  });

  return { ...outcome, archived: true };
}
