/**
 * @module L4.AsyncTaskSystem.WaitDisposition
 * @layer L4 核心层
 *
 * Phase 1934 Step D（F-13）：ATS 启动恢复（task-recovery）与运行中唤醒/到期
 * （system resumeWaitingTasks / deadline 定时器）共用的等待处置协议——同一
 * 磁盘事实在三入口下得到一致结果。
 *
 * 判定为 ATS 内部类型，不包含供应商概念（scope 为 opaque 标识，ready 结论
 * 由装配注入的 LLMWaitGate 给出，ATS 只消费）。
 *
 * 协议（deadline 优先于 ready）：
 * - keep：gate 缺席/未就绪且未到期 → 保持 waiting（不投递不终态、不改写事实）。
 * - expired：走既有失败协议——投递失败通知（notified marker 幂等）→ 写
 *   terminalState='failed' terminal intent → move running→failed → 清事实；
 *   不是仅 move failed。每个 await 点失败留证、任务留 running，重试收敛
 *   （marker 保证投递恰好一次；terminal intent 保证 move 失败后的恢复路由）。
 * - resume：先持久化可恢复迁移意图（resumeIntent，保留首次 expiresAt）→ move
 *   running→pending → 清事实。意图持久化失败不 move（不丢等待身份）；move
 *   失败意图保留供重放；move 成功后清事实失败留证，残留意图由 pending 消费方
 *   确认清理完成再执行业务。
 *
 * 崩溃窗口：commit（move）前可用 mayProceed 做最后检查（shutdown 后不入
 * pending、取消竞争不复活）；move ENOENT = 已被别处处置（race），不作处置。
 */

import { formatErr } from '../../foundation/node-utils/index.js';
import { isFileNotFound, type FileSystem } from '../../foundation/fs/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import {
  TASKS_QUEUES_PENDING_DIR,
  TASKS_QUEUES_FAILED_DIR,
  TASKS_QUEUES_RESULTS_DIR,
} from './dirs.js';
import type { FullTaskId, SubAgentTask, ToolTask } from './types.js';
import { taskShortId } from './types.js';
import { clearLLMWait, persistLLMWait, type LLMWaitFact, type LLMWaitGate } from './llm-wait-state.js';
import {
  emitLLMWaitContinued,
  emitLLMWaitExpired,
  emitLLMWaitResumed,
  emitRecoveryFailed,
} from './audit-emit.js';
import { sendFallbackResult as defaultSendFallbackResult } from './result-delivery.js';
import type { SendFallbackResult, WriteInboxAsync } from './result-delivery-types.js';

/** 等待处置判定：deadline 优先于 ready（now >= expiresAt → expired）。 */
export type WaitDisposition = 'expired' | 'resume' | 'keep';

export function decideWait(now: number, expiresAt: number, ready: boolean): WaitDisposition {
  if (now >= expiresAt) return 'expired';
  return ready ? 'resume' : 'keep';
}

/** applyWaitDisposition 的 typed 结果。 */
export type WaitDispositionOutcome =
  /** 已回 pending 重调度（事实已清或清理失败留证——后者由 pending 消费方兜底）。 */
  | { kind: 'resumed' }
  /** 已转 failed（投递 + terminal intent + move 完成；清事实失败仅留证）。 */
  | { kind: 'expired' }
  /** 保持 waiting（gate 缺席/未就绪且未到期）。 */
  | { kind: 'kept'; reason: 'gate_absent' | 'gate_not_ready' }
  /** 处置中途失败/被 mayProceed 拦截：任务留 running、证据保留，重试收敛。 */
  | { kind: 'deferred' }
  /** commit 点任务文件已消失（cancel/dispatch 竞争）——不作处置、不算唤醒。 */
  | { kind: 'raced' };

export interface ApplyWaitDispositionDeps {
  fs: FileSystem;
  auditWriter: AuditLog;
  /** expired 投递（缺省走标准实现；测试注入 mock）。 */
  sendFallbackResult?: SendFallbackResult<SubAgentTask | ToolTask>;
  writeInboxAsync?: WriteInboxAsync;
}

export interface ApplyWaitDispositionOpts {
  /** running/ 中的任务文件路径。 */
  filePath: string;
  task: SubAgentTask;
  fact: LLMWaitFact;
  /** 装配注入 gate；缺席 = 未就绪（但 deadline 仍可到期）。 */
  gate?: LLMWaitGate;
  /** 时钟注入（默认 Date.now()）。 */
  now?: number;
  /**
   * commit（move）前最后检查：返回 false → 放弃本次处置保持 waiting
   * （shutdown 后不入 pending / 取消竞争不复活）。
   */
  mayProceed?: () => boolean;
}

/**
 * 统一等待处置：先校验后的 task + 有效事实 → 判定 → 执行。
 * 调用方负责：task 文件已读且 validateTaskShape 通过、事实 loadLLMWait 为 ok。
 */
export async function applyWaitDisposition(
  deps: ApplyWaitDispositionDeps,
  opts: ApplyWaitDispositionOpts,
): Promise<WaitDispositionOutcome> {
  const { task, fact, gate } = opts;
  const now = opts.now ?? Date.now();
  const fullTaskId = task.id as FullTaskId;
  const shortTaskId = taskShortId(task);
  const ready = gate ? gate.canResume(fact.scope) : false;
  const disposition = decideWait(now, fact.expiresAt, ready);

  if (disposition === 'keep') {
    const reason = gate ? 'gate_not_ready' : 'gate_absent';
    emitLLMWaitContinued(deps.auditWriter, {
      fullTaskId,
      shortTaskId,
      scope: fact.scope,
      nextProbeAt: fact.nextProbeAt,
      reason,
    });
    return { kind: 'kept', reason };
  }

  if (opts.mayProceed && !opts.mayProceed()) return { kind: 'deferred' };
  if (disposition === 'expired') return expireWait(deps, opts);
  return resumeWait(deps, opts, now);
}

/**
 * resume：意图 → move → 清事实。
 * - 意图持久化失败 → 不 move（无意图的 move 失败会丢等待身份）；
 * - move 失败 → 意图保留（重启按意图重放；expiresAt 不重置）；
 * - move ENOENT → raced（已被别处处置）；
 * - move 成功后清事实失败 → 留证，残留意图由 pending 消费方清理。
 */
async function resumeWait(
  deps: ApplyWaitDispositionDeps,
  opts: ApplyWaitDispositionOpts,
  now: number,
): Promise<WaitDispositionOutcome> {
  const { fs, auditWriter } = deps;
  const { filePath, task, fact } = opts;
  const fullTaskId = task.id as FullTaskId;
  const shortTaskId = taskShortId(task);
  const resultDir = `${TASKS_QUEUES_RESULTS_DIR}/${task.id}`;

  try {
    await persistLLMWait(fs, resultDir, {
      ...fact,
      resumeIntent: { target: 'pending', decidedAt: now },
    });
  } catch (err) {
    emitRecoveryFailed(auditWriter, {
      taskId: task.id,
      context: 'llm_wait_resume_intent_failed',
      error: formatErr(err),
    });
    return { kind: 'deferred' };
  }

  if (opts.mayProceed && !opts.mayProceed()) return { kind: 'deferred' };
  try {
    await fs.move(filePath, `${TASKS_QUEUES_PENDING_DIR}/${task.id}.json`);
  } catch (err) {
    if (isFileNotFound(err)) return { kind: 'raced' };
    emitRecoveryFailed(auditWriter, {
      taskId: task.id,
      context: 'llm_wait_resume_move_failed',
      error: formatErr(err),
    });
    return { kind: 'deferred' };
  }

  try {
    await clearLLMWait(fs, resultDir);
  } catch (err) {
    emitRecoveryFailed(auditWriter, {
      taskId: task.id,
      context: 'llm_wait_resume_clear_failed',
      error: formatErr(err),
    });
  }
  emitLLMWaitResumed(auditWriter, { fullTaskId, shortTaskId, scope: fact.scope });
  return { kind: 'resumed' };
}

/**
 * expired：投递（marker 幂等）→ terminal intent → move failed → 清事实。
 * - 投递/marker/terminal intent 失败 → 留 running 重试（marker 保证不重复投递）；
 * - move 失败 → terminal intent 保证恢复路由（不依赖事实是否还在）；
 * - move ENOENT → raced；move 成功后清事实失败 → 仅留证（任务已终态）。
 */
async function expireWait(
  deps: ApplyWaitDispositionDeps,
  opts: ApplyWaitDispositionOpts,
): Promise<WaitDispositionOutcome> {
  const { fs, auditWriter } = deps;
  const { filePath, task, fact } = opts;
  const fullTaskId = task.id as FullTaskId;
  const shortTaskId = taskShortId(task);
  const resultDir = `${TASKS_QUEUES_RESULTS_DIR}/${task.id}`;

  emitLLMWaitExpired(auditWriter, { fullTaskId, shortTaskId, scope: fact.scope, expiresAt: fact.expiresAt });

  const markerPath = `${resultDir}/result.txt.notified`;
  let alreadyNotified = false;
  try {
    alreadyNotified = await fs.exists(markerPath);
  } catch (err) {
    emitRecoveryFailed(auditWriter, {
      taskId: task.id,
      context: 'llm_wait_expired_marker_read_failed',
      error: formatErr(err),
    });
    return { kind: 'deferred' };
  }
  if (!alreadyNotified) {
    const sendFallback = deps.sendFallbackResult ?? defaultSendFallbackResult;
    try {
      await sendFallback(fs, auditWriter, task, {
        schema_version: 1,
        content: `LLM wait deadline expired (scope=${fact.scope}, expiresAt=${fact.expiresAt}). Task failed without resumption.`,
        isError: true,
      }, { writeInboxAsync: deps.writeInboxAsync });
    } catch (err) {
      emitRecoveryFailed(auditWriter, {
        taskId: task.id,
        context: 'llm_wait_expired_notify_failed',
        error: formatErr(err),
      });
      return { kind: 'deferred' };
    }
    try {
      await fs.writeAtomic(markerPath, '');
    } catch (err) {
      emitRecoveryFailed(auditWriter, {
        taskId: task.id,
        context: 'llm_wait_expired_marker_write_failed',
        error: formatErr(err),
      });
      return { kind: 'deferred' };
    }
  }

  try {
    await writeTerminalIntent(fs, filePath, 'failed');
  } catch (err) {
    emitRecoveryFailed(auditWriter, {
      taskId: task.id,
      context: 'llm_wait_expired_terminal_intent_failed',
      error: formatErr(err),
    });
    return { kind: 'deferred' };
  }

  if (opts.mayProceed && !opts.mayProceed()) return { kind: 'deferred' };
  try {
    await fs.move(filePath, `${TASKS_QUEUES_FAILED_DIR}/${task.id}.json`);
  } catch (err) {
    if (isFileNotFound(err)) return { kind: 'raced' };
    emitRecoveryFailed(auditWriter, {
      taskId: task.id,
      context: 'llm_wait_expired_move_failed',
      error: formatErr(err),
    });
    return { kind: 'deferred' };
  }

  try {
    await clearLLMWait(fs, resultDir);
  } catch (err) {
    emitRecoveryFailed(auditWriter, {
      taskId: task.id,
      context: 'llm_wait_expired_clear_failed',
      error: formatErr(err),
    });
  }
  return { kind: 'expired' };
}

/**
 * terminal intent：写 terminalState 进 running 任务文件（mirror
 * system._setTerminalState 协议——move 失败时恢复据此路由）。
 */
async function writeTerminalIntent(
  fs: FileSystem,
  filePath: string,
  state: 'done' | 'failed',
): Promise<void> {
  const raw = await fs.read(filePath);
  const task = JSON.parse(raw) as Record<string, unknown>;
  task.terminalState = state;
  await fs.writeAtomic(filePath, JSON.stringify(task));
}
