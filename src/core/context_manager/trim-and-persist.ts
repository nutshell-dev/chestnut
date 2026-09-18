/**
 * @module L4.ContextManager.TrimAndPersist
 * 事件性裁剪 + 持久化同源（phase 421 ratify、phase 440 实施、phase 1153 区分 proactive/reactive）。
 */

import type { ToolDefinition } from '../../foundation/llm-provider/index.js';
import type { Message, DialogSaveResult } from '../../foundation/dialog-store/index.js';
import { applyBlockIdAssignments } from '../../foundation/dialog-store/index.js';
import type { TraceId } from '../../foundation/audit/index.js';
import {
  estimateTextTokens,
  estimateToolsTokens,
} from '../../foundation/llm-provider/index.js';
import { trimV2, type AuditWriter, type TrimPolicy, type ContextTrimOutcome } from './trim-v2.js';
import { CONTEXT_TRIM_ARCHIVED } from './audit-events.js';
import { ContextTrimPersistError } from './errors.js';

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

interface TrimAndPersistInputs {
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
 * - invalid progress → ContextTrimPersistError('invalid_progress')（phase 1861 CM-D7）
 * - archive 失败 → ContextTrimPersistError('archive')、不调 save、上抛（caller decide failover）
 * - save 失败 → ContextTrimPersistError('save')、archive 已生效但 current.json 内容仍是旧版本（下次 load 走 archive fallback）
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
    throw new ContextTrimPersistError(
      'invalid_progress',
      `invalid trim progress: ${outcome.after} >= ${outcome.before}`,
    );
  }

  try {
    await inputs.dialogStore.archive();
  } catch (e) {
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
      messages: outcome.newMessages,
      toolsForLLM: inputs.toolsForLLM,
    });
  } catch (e) {
    throw new ContextTrimPersistError('save', 'trim save failed', { cause: e });
  }
  // phase 1850 Step C: 显式回传 blockId 到 outcome.newMessages（该数组被上层继续持有）
  applyBlockIdAssignments(outcome.newMessages, saved.assignedBlockIds);

  return { ...outcome, archived: true };
}
