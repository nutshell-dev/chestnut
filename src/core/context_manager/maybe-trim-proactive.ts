/**
 * @module L4.ContextManager.MaybeTrimProactive
 * 顺手裁触发：turn 入口判断「占用率 ≥ 0.75 AND 缓存已失效」、满足则调 trimAndPersist。
 */

import type { ToolDefinition } from '../../foundation/llm-provider/index.js';
import type { Message } from '../../foundation/dialog-store/index.js';
import {
  estimateTextTokens,
  estimateMessagesTokens,
  estimateToolsTokens,
} from '../../foundation/llm-provider/index.js';
import { trimAndPersist, type DialogStoreMutationCapability } from './trim-and-persist.js';
import type { ContextTrimOutcome } from './trim-v2.js';
import type { TrimRuntimePolicy } from './constants.js';
import { buildProactiveTrimPolicy } from './trim-v2.js';

import type { AuditWriter } from './trim-v2.js';

export interface MaybeTrimProactiveInputs {
  messages: Message[];
  systemPrompt: string;
  toolsForLLM: ToolDefinition[];
  contextWindow: number;

  /** phase 1861 (CM-D2)：缓存已失效事实（含「非首次」语义）——由 owner（caller/Runtime）判定注入。 */
  cacheExpired: boolean;

  dialogStore: DialogStoreMutationCapability;
  audit: AuditWriter;

  /** phase 1861 (CM-D8)：时钟值必传（caller 侧取得）。 */
  now: number;

  /** phase 1861 (CM-D1)：裁剪规则边界值（recentWindowMs/previewBytes/targetRatio 由 caller 注入）。 */
  policy: TrimRuntimePolicy;
}

/**
 * 顺手裁触发：turn 入口判断「占用率 ≥ 0.75 AND 缓存已失效」、满足则调 trimAndPersist。
 *
 * 触发条件（3 件全满足）：
 * 1. 缓存已失效（caller 注入 cacheExpired；TTL 判据与「非首次」归 caller/Runtime）
 * 2. 占用率 ≥ 0.75（estimateMessagesTokens ≥ targetMessagesTokens）
 * 3. dialogStore 可用（caller 已提供）
 *
 * 不触发返 null；触发则返 TrimAndPersistResult（含 newMessages 引用、caller 替换自身引用）。
 */
export async function maybeTrimProactive(
  inputs: MaybeTrimProactiveInputs,
): Promise<ContextTrimOutcome | null> {
  const now = inputs.now;

  // 1. 缓存未失效不触发（失效判据由 caller 计算注入）
  if (!inputs.cacheExpired) return null;

  // 2. 算消息历史上限（proactive target 为完整 prompt 上限；减去 fixed 得消息上限）
  const proactivePolicy = buildProactiveTrimPolicy(inputs.contextWindow, {
    targetRatio: inputs.policy.targetRatio,
  });
  const targetMessagesTokens = proactivePolicy.targetCompleteTokens
    - estimateTextTokens(inputs.systemPrompt)
    - estimateToolsTokens(inputs.toolsForLLM);

  // 3. 占用率 < 0.75 不触发
  const estimatedTokens = estimateMessagesTokens(inputs.messages);
  if (estimatedTokens < targetMessagesTokens) return null;

  // 5. 触发顺手裁
  return await trimAndPersist({
    messages: inputs.messages,
    systemPrompt: inputs.systemPrompt,
    toolsForLLM: inputs.toolsForLLM,
    contextWindow: inputs.contextWindow,
    recentWindowMs: inputs.policy.recentWindowMs,
    previewBytes: inputs.policy.previewBytes,
    dialogStore: inputs.dialogStore,
    audit: inputs.audit,
    triggerKind: 'proactive_cache_idle',
    policy: buildProactiveTrimPolicy(inputs.contextWindow, {
      targetRatio: inputs.policy.targetRatio,
    }),
    now,
  });
}
