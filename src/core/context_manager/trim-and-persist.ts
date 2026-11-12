/**
 * @module L4.ContextManager.TrimAndPersist
 * 事件性裁剪 + 持久化同源（phase 421 ratify、phase 440 实施、phase 1153 区分 proactive/reactive）。
 */

import type { ToolDefinition, InputMeasurement, InputMeterDescriptor } from '../../foundation/llm-provider/index.js';
import type { Message, DialogSaveResult } from '../../foundation/dialog-store/index.js';
import { applyBlockIdAssignments } from '../../foundation/dialog-store/index.js';
import type { TraceId } from '../../foundation/audit/index.js';
import {
  estimateTextTokens,
  estimateToolsTokens,
} from '../../foundation/llm-provider/index.js';
import { trimV2, type AuditWriter, type TrimPolicy, type ContextTrimOutcome } from './trim-v2.js';
import { CONTEXT_TRIM_ARCHIVED, CONTEXT_TRIM_FAILED } from './audit-events.js';
import { ContextTrimPersistError } from './errors.js';
import { formatErr } from '../../foundation/node-utils/index.js';

export type TriggerKind = 'reactive_overflow' | 'proactive_cache_idle';

/**
 * Phase 1218 Step B: minimal DialogStore mutation capability borrowed by
 * ContextManager helpers. Only archive() + save() are required; this prevents
 * helpers from holding a full DialogStore reference as secondary writer.
 */
export interface DialogStoreMutationCapability {
  archive(): Promise<void>;
  // phase 1850 Step B: save 双文件提交协议——返回结构化 DialogSaveResult
  // phase 1850 Step C: helper 消费 assignedBlockIds 显式写回 outcome.newMessages（save 不再隐式写 caller 数组）
  save(snapshot: {
    systemPrompt: string;
    messages: Message[];
    toolsForLLM: ToolDefinition[];
    trace_id?: TraceId;
  }): Promise<DialogSaveResult>;
}

export interface TrimAndPersistInputs {
  messages: Message[];
  systemPrompt: string;
  toolsForLLM: ToolDefinition[];
  contextWindow: number;
  recentWindowMs: number;
  previewBytes: number;
  dialogStore: DialogStoreMutationCapability;
  audit: AuditWriter;
  triggerKind: TriggerKind;
  policy: TrimPolicy;
  measureComplete?: (messages: readonly Message[]) => InputMeasurement;
  measurementDescriptor?: Readonly<InputMeterDescriptor>;
  now?: number;
}

/**
 * 事件性裁剪 + 持久化同源。
 *
 * 流程：
 * 1. 跑 trimV2 只读预判（pure function、返回 discriminated outcome）
 * 2. no_progress / policy_conflict → 不持久化，直接返回 outcome
 * 3. target_reached / progress → 先保存裁前输入并写回 blockId，确保 archive
 *    包含本次 turn 的完整原文
 * 4. 重新基于带 blockId 的原文运行 trimV2，生成可提交候选
 * 5. archive() 备份精确裁前 current.json，再 save 裁后 snapshot
 * 6. 仅在 archive + save 成功后返回 archived=true
 *
 * 异常路径：
 * - invalid progress → ContextTrimPersistError('invalid_progress')（phase 1861 CM-D7）
 * - 裁前 save 失败 → ContextTrimPersistError('before_save')、不调 archive、上抛
 * - archive 失败 → ContextTrimPersistError('archive')、不调裁后 save、上抛
 * - 裁后 save 失败 → ContextTrimPersistError('save')、archive 已生效（下次 load 走 archive fallback）
 */
export async function trimAndPersist(
  inputs: TrimAndPersistInputs,
): Promise<ContextTrimOutcome> {
  const now = inputs.now ?? Date.now();

  const fixedTokens = estimateTextTokens(inputs.systemPrompt)
    + estimateToolsTokens(inputs.toolsForLLM);

  const runTrim = () => trimV2(inputs.messages, {
    recentWindowMs: inputs.recentWindowMs,
    previewBytes: inputs.previewBytes,
    fixedTokens,
    measureComplete: inputs.measureComplete,
    measurementDescriptor: inputs.measurementDescriptor,
    policy: inputs.policy,
    now,
    audit: inputs.audit,
  });

  let result = runTrim();

  const outcome = result.outcome;

  if (outcome.status === 'no_progress' || outcome.status === 'policy_conflict') {
    return { ...outcome, archived: false };
  }

  if (outcome.after >= outcome.before) {
    inputs.audit.write(
      CONTEXT_TRIM_FAILED,
      `stage=invalid_progress`,
      `trigger_kind=${inputs.triggerKind}`,
      `error=invalid trim progress: ${outcome.after} >= ${outcome.before}`,
    );
    throw new ContextTrimPersistError(
      'invalid_progress',
      `invalid trim progress: ${outcome.after} >= ${outcome.before}`,
    );
  }

  let beforeSaved: DialogSaveResult;
  try {
    // 先落盘裁前输入并拿到 blockId。这样 archive 移动的 current.json 是本次
    // turn 的精确原文；同一批 ID 会被 trim 候选复用，不会因前后两次 save
    // 产生两套 block 身份。
    beforeSaved = await inputs.dialogStore.save({
      systemPrompt: inputs.systemPrompt,
      messages: inputs.messages,
      toolsForLLM: inputs.toolsForLLM,
    });
    applyBlockIdAssignments(inputs.messages, beforeSaved.assignedBlockIds);
  } catch (e) {
    inputs.audit.write(
      CONTEXT_TRIM_FAILED,
      `stage=before_save`,
      `trigger_kind=${inputs.triggerKind}`,
      `error=${formatErr(e)}`,
    );
    throw new ContextTrimPersistError('before_save', 'trim pre-save failed', { cause: e });
  }

  // blockId 会出现在折叠占位符中，因此必须在赋 ID 后重算候选和最终 token 数。
  result = runTrim();
  if (result.outcome.status === 'no_progress' || result.outcome.status === 'policy_conflict') {
    return { ...result.outcome, archived: false };
  }
  if (result.outcome.after >= result.outcome.before) {
    inputs.audit.write(
      CONTEXT_TRIM_FAILED,
      `stage=invalid_progress`,
      `trigger_kind=${inputs.triggerKind}`,
      `error=invalid trim progress after blockId assignment: ${result.outcome.after} >= ${result.outcome.before}`,
    );
    throw new ContextTrimPersistError(
      'invalid_progress',
      `invalid trim progress after blockId assignment: ${result.outcome.after} >= ${result.outcome.before}`,
    );
  }
  const outcomeWithIds = result.outcome;

  try {
    await inputs.dialogStore.archive();
  } catch (e) {
    inputs.audit.write(
      CONTEXT_TRIM_FAILED,
      `stage=archive`,
      `trigger_kind=${inputs.triggerKind}`,
      `error=${formatErr(e)}`,
    );
    throw new ContextTrimPersistError('archive', 'trim archive failed', { cause: e });
  }
  inputs.audit.write(
    CONTEXT_TRIM_ARCHIVED,
    `trigger_kind=${inputs.triggerKind}`,
  );

  let saved;
  try {
    saved = await inputs.dialogStore.save({
      systemPrompt: inputs.systemPrompt,
      messages: outcomeWithIds.newMessages,
      toolsForLLM: inputs.toolsForLLM,
    });
  } catch (e) {
    inputs.audit.write(
      CONTEXT_TRIM_FAILED,
      `stage=save`,
      `trigger_kind=${inputs.triggerKind}`,
      `error=${formatErr(e)}`,
    );
    throw new ContextTrimPersistError('save', 'trim save failed', { cause: e });
  }
  // phase 1850 Step C: 显式回传 blockId 到 outcome.newMessages（该数组被上层继续持有）
  applyBlockIdAssignments(outcomeWithIds.newMessages, saved.assignedBlockIds);

  return { ...outcomeWithIds, archived: true };
}
