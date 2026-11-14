/**
 * @module L4.ContextManager.MaybeTrimProactive
 * 顺手裁触发：turn 入口判断「占用率 ≥ 0.75 AND 缓存已失效」、满足则调 trimAndPersist。
 */

import type { ToolDefinition, InputMeasurement, InputMeasurementCapability, InputMeterDescriptor } from '../../foundation/llm-provider/index.js';
import type { Message } from '../../foundation/dialog-store/index.js';
import {
  estimateTextTokens,
  estimateMessagesTokens,
  estimateToolsTokens,
} from '../../foundation/llm-provider/index.js';
import { trimAndPersist, type DialogStoreMutationCapability } from './trim-and-persist.js';
import type { ContextTrimOutcome } from './trim-v2.js';
import type { TrimRuntimePolicy } from './constants.js';
import {
  CONTEXT_TRIM_PROACTIVE_TRIGGER_RATIO,
  CONTEXT_TRIM_PROACTIVE_TARGET_RATIO,
} from './constants.js';
import { buildProactiveTrimPolicy } from './trim-v2.js';
import { ContextInputMeasurementError } from './errors.js';

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

  /** phase 2100：触发与目标比率分离；旧 targetRatio 仅作兼容别名。 */
  policy: TrimRuntimePolicy;
  measureComplete?: (messages: readonly Message[]) => InputMeasurement;
  measurementCapability?: InputMeasurementCapability;
  measurementDescriptor?: Readonly<InputMeterDescriptor>;
}

/**
 * 顺手裁触发：turn 入口判断「占用率 ≥ 0.75 AND 缓存已失效」、满足则调 trimAndPersist。
 *
 * 触发条件（3 件全满足）：
 * 1. 缓存已失效（caller 注入 cacheExpired；TTL 判据与「非首次」归 caller/Runtime）
 * 2. 完整输入占用率 ≥ 0.75（优先使用 measureComplete；无 meter 时保留 legacy fallback）
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
  const proactiveTargetRatio = inputs.policy.proactiveTargetRatio ?? inputs.policy.targetRatio ?? CONTEXT_TRIM_PROACTIVE_TARGET_RATIO;
  const proactiveTriggerRatio = inputs.policy.proactiveTriggerRatio ?? CONTEXT_TRIM_PROACTIVE_TRIGGER_RATIO;
  const triggerTokens = Math.floor(inputs.contextWindow * proactiveTriggerRatio);

  // 3. 占用率 < 0.75 不触发。完整 meter 是可用时的唯一触发事实，不能与
  // legacy fixed/message estimate 混算；unavailable 必须保留 typed recovery 语义。
  if (inputs.measureComplete) {
    const measurement = inputs.measureComplete(inputs.messages);
    if (measurement.kind === 'unavailable') {
      throw new ContextInputMeasurementError(measurement.reason, inputs.measurementDescriptor);
    }
    if (measurement.tokens < triggerTokens) return null;
  } else {
    const fixedTokens = estimateTextTokens(inputs.systemPrompt) + estimateToolsTokens(inputs.toolsForLLM);
    const estimatedTokens = estimateMessagesTokens(inputs.messages);
    if (fixedTokens + estimatedTokens < triggerTokens) return null;
  }

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
      targetRatio: proactiveTargetRatio,
    }),
    measureComplete: inputs.measureComplete,
    measurementCapability: inputs.measurementCapability,
    measurementDescriptor: inputs.measurementDescriptor,
    now,
  });
}
