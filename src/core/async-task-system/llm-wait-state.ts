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
 * 进程内唤醒（resumeWaitingTasks）与 deadline 到期检查已由 Phase 1933 Step F /
 * Phase 1934 Step D 落地，启动恢复、ready 唤醒、deadline 定时器三入口共用
 * wait-disposition 处置协议。
 *
 * Phase 1934 Step D（F-13 统一处置）：
 * - resumeIntent 迁移意图字段：resume 处置先持久化意图再 move 再清事实，
 *   move 失败不丢等待身份（重启按意图重放）；严格 schema，旧记录（无意图
 *   字段）兼容读取，意图非法 → 整份记录 corrupt（不猜）。
 * - 损坏记录统一语义：不删除（原文保留作证据；不清未知记录）——启动恢复
 *   留证后 fall through 既有决策序（任务离开 running 即不再触碰，无死循环），
 *   运行中唤醒留证不动。
 * - deadline 用首次持久 expiresAt：处置路径（含意图重放）不改写 expiresAt。
 *
 * Phase 1934 Z-D1（等待预算帽）：
 * - llm-wait-deadline.json 记录任务首个等待 deadline（跨唤醒周期保留，不随
 *   等待事实清除）；第二次起的等待事实 expiresAt 由 ATS 钳制到首次 deadline
 *   （写入点见 subagent-executor waiting 分支），不随唤醒重获完整 task.timeoutMs。
 * - expiresAt < recordedAt 不再视为损坏：钳制到过去的 deadline 是合法状态
 *   （唤醒后预算已耗尽），语义 = 立即到期（decideWait 的 deadline 优先规则
 *   消费）；recordedAt 如实记录本轮等待时刻（证据字段不伪造）。
 */

import { isFileNotFound, type FileSystem } from '../../foundation/fs/index.js';
import { formatErr } from '../../foundation/node-utils/index.js';

/**
 * resume 迁移意图（Phase 1934 Step D）：resume 处置先持久化意图再 move，
 * 崩溃/move 失败后重启按意图重放，等待身份不丢。
 */
export interface LLMWaitResumeIntent {
  target: 'pending';
  decidedAt: number;
}

/** 持久等待事实（tasks/queues/results/<id>/llm-wait.json）。 */
export interface LLMWaitFact {
  /** 进程内 orchestrator scope（opaque，ATS 不解析）。 */
  scope: string;
  /** ms epoch；来自 orchestrator snapshot 的最早可探测时刻下界。 */
  nextProbeAt: number;
  recordedAt: number;
  /** 等待 deadline；过期 → failed（不误转成功）。ATS 钳制到首次持久 deadline
   *  （Z-D1 预算帽）；钳制到过去 = 立即到期（合法，非损坏）。 */
  expiresAt: number;
  /** 显示摘要。 */
  reason: string;
  /** 可恢复迁移意图（缺席 = 未开始迁移；旧记录兼容读取）。 */
  resumeIntent?: LLMWaitResumeIntent;
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
    // 意图字段仅 resume 处置携带（executor 首次落盘无意图）
    ...(fact.resumeIntent ? { resumeIntent: fact.resumeIntent } : {}),
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
  // Phase 1934 Z-D1：expiresAt < recordedAt 合法（预算帽钳制到过去 = 立即到期），
  // 不再是 corrupt 条件；expiresAt 只需是有限数（上方已检）。
  if (typeof rec.reason !== 'string') return 'reason_not_string';
  // 意图字段严格 schema（Phase 1934 Step D）：缺席 = 旧记录兼容；在场非法 = corrupt
  if (rec.resumeIntent !== undefined) {
    const intent = rec.resumeIntent;
    if (typeof intent !== 'object' || intent === null) return 'resumeIntent_not_object';
    const rec2 = intent as Record<string, unknown>;
    if (rec2.target !== 'pending') return 'resumeIntent_target_invalid';
    if (!isFiniteNumber(rec2.decidedAt)) return 'resumeIntent_decidedAt_not_finite_number';
  }
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
  const intent = rec.resumeIntent as { target: 'pending'; decidedAt: number } | undefined;
  return {
    kind: 'ok',
    fact: {
      scope: rec.scope as string,
      nextProbeAt: rec.nextProbeAt as number,
      recordedAt: rec.recordedAt as number,
      expiresAt: rec.expiresAt as number,
      reason: rec.reason as string,
      ...(intent ? { resumeIntent: { target: intent.target, decidedAt: intent.decidedAt } } : {}),
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

// ─── Phase 1934 Z-D1：首次等待 deadline 记录（跨唤醒周期的等待预算帽） ──────

/**
 * 首次等待 deadline 记录文件名（归本模块 own）。
 * 与等待事实（LLM_WAIT_FILE）生命周期不同：事实在唤醒/终态时清除，本记录不随
 * 事实清除（任务 id 唯一、results 目录随任务归档，残留不污染其他任务）——
 * 第二次起的等待预算由 ATS 钳制到本记录（不随唤醒重获完整 task.timeoutMs）。
 */
export const LLM_WAIT_DEADLINE_FILE = 'llm-wait-deadline.json' as const;

const LLM_WAIT_DEADLINE_SCHEMA_VERSION = 1;

/** readOrInitWaitDeadline 的 typed 结果。 */
export type WaitDeadlineInit =
  /** 读取/初始化成功；reused = true 表示复用既有首次 deadline（未改写）。 */
  | { kind: 'ok'; expiresAt: number; reused: boolean }
  /** 记录损坏：原文已改名备份（留证、不删除），按提案重建。detail 描述损坏原因。 */
  | { kind: 'repaired'; expiresAt: number; detail: string };

/**
 * Phase 1934 Z-D1：读取或初始化任务首个等待 deadline（跨唤醒周期的预算帽）。
 *
 * - 已存在且合法 → 返回已存值（后续等待预算被钳制到首次 deadline）；
 * - 缺席 → 原子写 proposedExpiresAt 并返回（写失败 throw，调用方留 running 重试）；
 * - 损坏不猜：原文改名备份（留证）后按提案重建——损坏是永不发生的场景，
 *   重建保证任务不死锁；audit 留证归调用方（本模块不依赖 audit）。
 */
export async function readOrInitWaitDeadline(
  fs: FileSystem,
  taskResultDir: string,
  proposedExpiresAt: number,
): Promise<WaitDeadlineInit> {
  const deadlinePath = `${taskResultDir}/${LLM_WAIT_DEADLINE_FILE}`;
  const writeDeadline = () => fs.writeAtomic(deadlinePath, JSON.stringify({
    schema_version: LLM_WAIT_DEADLINE_SCHEMA_VERSION,
    expiresAt: proposedExpiresAt,
  }));
  if (!(await fs.exists(deadlinePath))) {
    await writeDeadline();
    return { kind: 'ok', expiresAt: proposedExpiresAt, reused: false };
  }
  let raw: string;
  try {
    raw = await fs.read(deadlinePath);
  } catch (err) {
    if (isFileNotFound(err)) {
      // TOCTOU：exists 后被删——按缺席处理
      await writeDeadline();
      return { kind: 'ok', expiresAt: proposedExpiresAt, reused: false };
    }
    throw err;
  }
  let detail: string;
  try {
    const parsed: unknown = JSON.parse(raw);
    const rec = parsed as Record<string, unknown> | null;
    if (rec !== null && typeof rec === 'object'
      && rec.schema_version === LLM_WAIT_DEADLINE_SCHEMA_VERSION
      && isFiniteNumber(rec.expiresAt)) {
      return { kind: 'ok', expiresAt: rec.expiresAt, reused: true };
    }
    detail = 'shape_mismatch';
  } catch (err) {
    detail = `invalid_json:${formatErr(err)}`;
  }
  await fs.move(deadlinePath, `${deadlinePath}.corrupt-${Date.now()}`);
  await writeDeadline();
  return { kind: 'repaired', expiresAt: proposedExpiresAt, detail };
}
