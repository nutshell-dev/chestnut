/**
 * @module L4.AsyncTaskSystem.LLMWaitState
 * @layer L4 核心层
 *
 * Phase 1933 Step E：ATS 持久等待事实（llm-wait.json）的唯一 owner
 * （文件位置 / schema / 读写归本模块）。
 *
 * 共享 LLM 故障（LLMAllProvidersFailedError = 进程内全 provider 失败）导致的
 * 等待被持久化到任务 result 目录（tasks/queues/results/<id>/llm-wait.json）；
 * 进程重启后由 task-recovery 消费：gate 就绪 → 回 pending 重调度；未就绪 →
 * 保持 waiting（任务留 running/，不投递不终态）；deadline 过期 → failed
 * （不误转成功）。
 *
 * 边界：ATS 只持久化任务生命周期事实；LLM 故障判定与探针归
 * foundation/llm-orchestrator——scope 为 opaque 标识，ATS 不解析、不自行探测。
 *
 * 进程内唤醒（gate 就绪信号 → 立即重调度）不在本 phase：唤醒入口仅启动恢复
 * 路径；进程内探针定时唤醒留后续 phase 接 EventLoop 恢复信号。
 */

import { isFileNotFound, type FileSystem } from '../../foundation/fs/index.js';
import { formatErr } from '../../foundation/node-utils/index.js';

/** 持久等待事实（tasks/queues/results/<id>/llm-wait.json）。 */
export interface LLMWaitFact {
  /** 进程内 orchestrator scope（opaque，ATS 不解析）。 */
  scope: string;
  /** ms epoch；来自 orchestrator snapshot 的最早可探测时刻下界。 */
  nextProbeAt: number;
  recordedAt: number;
  /** 等待 deadline；过期 → failed（不误转成功）。 */
  expiresAt: number;
  /** 显示摘要。 */
  reason: string;
}

/**
 * 等待 gate（装配期注入）：LLM 是否已恢复可由 orchestrator 结论回答。
 * ATS 只消费结论；缺席（未注入）时恢复路径保持 waiting，不静默转终态。
 */
export interface LLMWaitGate {
  canResume(scope: string): boolean;
}

/** 等待事实文件名（归本模块 own）。 */
export const LLM_WAIT_FILE = 'llm-wait.json' as const;

const LLM_WAIT_SCHEMA_VERSION = 1;

/** loadLLMWait 的 typed 结果：ok = 严格校验通过；corrupt = 损坏（不猜默认值）。 */
export type LLMWaitLoadResult =
  | { kind: 'ok'; fact: LLMWaitFact }
  | { kind: 'corrupt'; detail: string };

/** 持久化等待事实（schema_version 包装原子写）；写失败 throw（调用方留 running 重试）。 */
export async function persistLLMWait(
  fs: FileSystem,
  taskResultDir: string,
  fact: LLMWaitFact,
): Promise<void> {
  await fs.writeAtomic(`${taskResultDir}/${LLM_WAIT_FILE}`, JSON.stringify({
    schema_version: LLM_WAIT_SCHEMA_VERSION,
    scope: fact.scope,
    nextProbeAt: fact.nextProbeAt,
    recordedAt: fact.recordedAt,
    expiresAt: fact.expiresAt,
    reason: fact.reason,
  }));
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * 严格校验等待事实：任一字段不合规返回 detail 描述（不猜默认值）。
 * 返回 null = 校验通过。
 */
function validateLLMWaitFact(parsed: unknown): string | null {
  if (typeof parsed !== 'object' || parsed === null) return 'not_an_object';
  const rec = parsed as Record<string, unknown>;
  if (rec.schema_version !== LLM_WAIT_SCHEMA_VERSION) {
    return `unsupported_schema_version:${String(rec.schema_version)}`;
  }
  if (typeof rec.scope !== 'string' || rec.scope.length === 0) return 'scope_empty';
  if (!isFiniteNumber(rec.recordedAt)) return 'recordedAt_not_finite_number';
  if (!isFiniteNumber(rec.nextProbeAt)) return 'nextProbeAt_not_finite_number';
  if (!isFiniteNumber(rec.expiresAt)) return 'expiresAt_not_finite_number';
  if (rec.nextProbeAt < rec.recordedAt) return 'nextProbeAt_before_recordedAt';
  if (rec.expiresAt < rec.recordedAt) return 'expiresAt_before_recordedAt';
  if (typeof rec.reason !== 'string') return 'reason_not_string';
  return null;
}

/**
 * 读取等待事实：缺失 → undefined；损坏（坏 JSON / schema 不符）→ typed corrupt
 * 结果（detail 描述，不猜）；非 ENOENT IO 错误 throw（由调用方留证）。
 */
export async function loadLLMWait(
  fs: FileSystem,
  taskResultDir: string,
): Promise<LLMWaitLoadResult | undefined> {
  const waitPath = `${taskResultDir}/${LLM_WAIT_FILE}`;
  // exists 先行（与 cancel/recovery 既有读路径同型）；read 仍容忍 ENOENT（TOCTOU）。
  if (!(await fs.exists(waitPath))) return undefined;
  let raw: string;
  try {
    raw = await fs.read(waitPath);
  } catch (err) {
    if (isFileNotFound(err)) return undefined;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { kind: 'corrupt', detail: `invalid_json:${formatErr(err)}` };
  }
  const invalid = validateLLMWaitFact(parsed);
  if (invalid !== null) return { kind: 'corrupt', detail: invalid };
  const rec = parsed as Record<string, unknown>;
  return {
    kind: 'ok',
    fact: {
      scope: rec.scope as string,
      nextProbeAt: rec.nextProbeAt as number,
      recordedAt: rec.recordedAt as number,
      expiresAt: rec.expiresAt as number,
      reason: rec.reason as string,
    },
  };
}

/**
 * 删除等待事实（唤醒 / 终态时调用）。ENOENT 容忍（事实本就缺席）；
 * 其他错误 throw（不静默吞掉 IO 故障）。
 */
export async function clearLLMWait(fs: FileSystem, taskResultDir: string): Promise<void> {
  try {
    await fs.delete(`${taskResultDir}/${LLM_WAIT_FILE}`);
  } catch (err) {
    if (isFileNotFound(err)) return;
    throw err;
  }
}
