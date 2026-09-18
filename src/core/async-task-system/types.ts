/**
 * @module L4.AsyncTaskSystem.Types
 * Hub-level type exports to break circular imports within async-task-system.
 * Extracted in phase 1314 (cluster #3 of 5 cleanup roadmap).
 */

import type { ToolUseId } from '../../foundation/llm-provider/index.js';
import type { Message } from '../../foundation/dialog-store/index.js';
import type { InboxWriter } from '../../foundation/messaging/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { ToolRegistry } from '../../foundation/tools/index.js';
import type { StreamLog } from '../../foundation/stream/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import type { ToolProfile } from '../../foundation/tool-protocol/index.js';
import type { WatcherFactory } from '../../foundation/file-watcher/index.js';

import { uuidToShort } from '../../foundation/node-utils/index.js';
import type { SummonDecisionMetadata } from './task-schemas.js';
import type { SendResult, SendFallbackResult, SendToolResult, WriteInboxAsync, ProcessedTaskResult } from './result-delivery-types.js';

// phase 64: TaskId brand 迁回（自 foundation/identity 解散）— types.ts 历史注释 admit
// 「物理迁自 core/async-task-system/types.ts」(phase 1365)
// per M#3 资源唯一归属（按业务真实归属、非机制 surface）+ M#1 task lifecycle 独立可变

declare const TaskIdBrand: unique symbol;
declare const FullTaskIdBrand: unique symbol;
declare const ShortTaskIdBrand: unique symbol;

/** UUID v4, 36 chars. Used for persistence paths, JSON id field, audit. */
export type FullTaskId = string & { readonly [FullTaskIdBrand]: true };
/** 8-char hex. Used for agent messages, CLI display, stream events. */
export type ShortTaskId = string & { readonly [ShortTaskIdBrand]: true };
/** Union alias for contexts that accept either. */
export type TaskId = FullTaskId | ShortTaskId;

/**
 * phase 1863 (AT-D11)：id 形态正则（构造入口严、反序列化入口宽容分离）。
 * full = UUID（randomUUID 产出，36 字符小写）；short = 8 位 hex（uuidToShort 产出）。
 */
const FULL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHORT_ID_RE = /^[0-9a-f]{8}$/i;

/** 构造入口（严）：非法格式拒绝，不再 unchecked cast。 */
export function makeFullTaskId(s: string): FullTaskId {
  if (!FULL_ID_RE.test(s)) throw new Error(`makeFullTaskId: invalid FullTaskId "${s}" (expected UUID)`);
  return s as FullTaskId;
}
/** 构造入口（严）：非法格式拒绝。 */
export function makeShortTaskId(s: string): ShortTaskId {
  if (!SHORT_ID_RE.test(s)) throw new Error(`makeShortTaskId: invalid ShortTaskId "${s}" (expected 8-char hex)`);
  return s as ShortTaskId;
}
/** @deprecated Use makeFullTaskId or makeShortTaskId. 两形态任一合法即通过。 */
export function makeTaskId(s: string): TaskId {
  if (FULL_ID_RE.test(s)) return s as FullTaskId;
  if (SHORT_ID_RE.test(s)) return s as ShortTaskId;
  throw new Error(`makeTaskId: invalid TaskId "${s}" (expected UUID or 8-char hex)`);
}

/**
 * phase 1863 (AT-D11)：反序列化入口（宽容，不抛）——供磁盘/存储读路径。
 * 非法值经 `onInvalid` 记录（调用方决定 audit/跳过），返回 undefined 由调用方处置。
 */
export function readFullTaskId(s: string, onInvalid?: (s: string) => void): FullTaskId | undefined {
  if (FULL_ID_RE.test(s)) return s as FullTaskId;
  onInvalid?.(s);
  return undefined;
}
/** phase 1863 (AT-D11)：反序列化入口（宽容，不抛）。 */
export function readShortTaskId(s: string, onInvalid?: (s: string) => void): ShortTaskId | undefined {
  if (SHORT_ID_RE.test(s)) return s as ShortTaskId;
  onInvalid?.(s);
  return undefined;
}

/**
 * phase 1863 (AT-D11)：legacy/历史值的显式采纳（宽容、不校验）——仅限磁盘/存储读路径
 * 已确认可能含历史非标准 id 的读取点（语义 = 原 unchecked cast 的行为保持）。
 * 新写入必须经 makeFullTaskId/makeShortTaskId 严格构造。
 */
export function adoptLegacyFullTaskId(s: string): FullTaskId { return s as FullTaskId; }
/** phase 1863 (AT-D11)：legacy shortId 采纳（读路径专用；原序校验由调用方既有检查承担）。 */
export function adoptLegacyShortTaskId(s: string): ShortTaskId { return s as ShortTaskId; }

/**
 * Derive the shortId from any TaskId. For FullTaskId returns first 8 chars; for legacy 8-char ids returns as-is.
 * phase 1863 (AT-D11)：语义保持不动——非 UUID 形态（历史值/fixture）按其原值返回（不拒绝）。
 */
export function deriveShortIdFromTaskId(taskId: TaskId): ShortTaskId {
  if (taskId.length === 36) return makeShortTaskId(uuidToShort(taskId));
  return adoptLegacyShortTaskId(taskId);
}

/**
 * Return the canonical shortId for a task object.
 * Prefers the persisted `shortId` field; falls back to deriving from `id`
 * for pre-migration tasks or test fixtures.
 * phase 1863 (AT-D11)：持久化的 shortId 经宽容读入口（历史值原样保留、不拒绝）。
 */
export function taskShortId(task: { id: TaskId; shortId?: ShortTaskId | string }): ShortTaskId {
  if (!task.shortId) return deriveShortIdFromTaskId(task.id);
  return readShortTaskId(task.shortId) ?? adoptLegacyShortTaskId(task.shortId);
}

/**
 * phase 1863 (AT-D8)：opaque typed correlation——记录来源事实（caller 自声明 source），
 * 通用模块不预设 caller universe、不参与执行裁决（tool profile 由显式 toolProfile 决定）。
 * 取值由各 caller 自声明（当前：'spawn_subagent' | 'shadow_subagent' | 任意）；
 * 不参与执行裁决。
 */
export interface TaskCorrelation {
  /** caller 自声明来源（opaque string）。 */
  readonly source: string;
  /** 可选引用（caller 语义）。 */
  readonly ref?: string;
}

/** Read-only task identity capability for query consumers. */
export interface TaskIdResolver {
  resolve(shortId: string): FullTaskId | undefined;
}

/** Owner-side task identity index, including persistence and mutation. */
export interface ShortIdIndex extends TaskIdResolver {
  needsRebuild: boolean;
  load(auditWriter?: { write: (event: string, payload: Record<string, unknown>) => void }): void;
  save(): void;
  has(shortId: string): boolean;
  add(
    shortId: ShortTaskId,
    fullId: FullTaskId,
    auditWriter?: { write: (event: string, payload: Record<string, unknown>) => void },
    context?: string,
  ): void;
  delete(shortId: ShortTaskId): void;
  reverseResolve(fullId: FullTaskId): ShortTaskId | undefined;
  deriveShortId(fullId: FullTaskId): ShortTaskId;
  /**
   * Return the canonical shortId for a fullId.
   * Uses reverse-resolve for registered tasks only (legacy tasks where shortId ≠ derive).
   * Returns undefined for unknown fullIds; callers decide whether to derive.
   */
  canonicalShortId(fullId: FullTaskId): ShortTaskId | undefined;
  rebuildFromDisk(
    fs: {
      existsSync(path: string): boolean;
      listSync(path: string, opts?: { includeDirs?: boolean }): Array<{ name: string }>;
      readSync(path: string): string;
    },
    auditWriter?: { write: (event: string, payload: Record<string, unknown>) => void },
  ): void;
}

export interface AsyncTaskSystemOptions {
  maxConcurrent?: number;
  auditWriter: AuditLog;
  retryBaseDelayMs?: number;
  parentStreamLog?: StreamLog;

  /**
   * phase 1863 (AT-D5)：最小执行面（装配期注入；LLM/registry/runSubagent 归实现方 adapter）。
   */
  taskExecutor: TaskExecutor;
  /**
   * phase 1863 (AT-D5)：最小交付面（装配期注入；标准实现见 result-delivery.createStandardDeliverySink）。
   */
  deliverySink: DeliverySink;
  /**
   * Self inbox for overflow notification (本 daemon 自家 inbox).
   * phase 37: rename from `motionInbox` 命名 hygiene (实际是本 daemon 自家、
   * worker case 不写 motion inbox)。motion daemon: 写 motion 自家; worker daemon: 写 worker 自家.
   */
  selfInbox?: InboxWriter;
  registry: ToolRegistry;     // NEW: caller 注入填充好的 registry / Assembly own 装配
  fsFactory: (baseDir: string) => FileSystem;
  /** phase 849: shortId ↔ fullId index for dual-key task IDs */
  shortIdIndex: ShortIdIndex;
  /** phase 86: optional WatcherFactory for DI (test mock injection) */
  createWatcher?: WatcherFactory;
  /** phase 1029: result-delivery 函数。测试注入 mock，生产默认真实实现。 */
  sendResult?: SendResult<SubAgentTask>;
  sendFallbackResult?: SendFallbackResult<SubAgentTask | ToolTask>;
  sendToolResult?: SendToolResult<ToolTask>;
  /** phase 1029: messaging 函数。测试注入 mock，生产默认真实实现。 */
  writeInboxAsync?: WriteInboxAsync;
  /** 待处理队列容量上限。默认 PENDING_QUEUE_MAX (1000)。 */
  pendingQueueMax?: number;
}


interface CommonSubAgentTaskFields {
  kind: 'subagent';
  id: TaskId;
  /** Phase 867: 8-char display ID persisted alongside full UUID id. */
  shortId: ShortTaskId;
  timeoutMs: number;
  // phase 1490: maxSteps optional / undefined → SubAgent boundary fallback to DEFAULT_MAX_STEPS
  maxSteps?: number;
  parentClawId: string;
  createdAt: string;
  /** phase 1863 (AT-D8)：opaque correlation（替换封闭 CallerType 枚举）。 */
  correlation?: TaskCorrelation;
  /** Persisted declarative tool capability; execution never derives it from caller identity. */
  toolProfile?: ToolProfile;
  originClawId?: string;                   // 创建链路源头，传给子 SubAgent
  postProcessor?: string;            // 声明式 post-processor 名称（registry lookup）
  systemPrompt?: string;                 // phase 546 internal field：caller-side specialized system prompt（agent 不可见 / 与 phase 470 砍 agent-facing spawn schema 不冲突 / fall-back DEFAULT_SUBAGENT_SYSTEM_PROMPT）
  /**
   * phase 1863 (AT-D7)：执行 owner 的 opaque 执行 payload（形态归 owner，如 shadow-system 的
   * ShadowExecutorPayload）；ATS 不枚举/解释其语义，经装配注入的 {@link ExecutorPayloadAdapter} 消费。
   */
  executorPayload?: unknown;
  /**
   * Legacy v1/v2 Summon recovery input; active writers must not populate.
   * Phase 1402 Step B: 当前 summon task 由 canonical postProcessor identity 识别，
   * 本字段仅为已落盘 v1/v2 task 的中断恢复读取保留；物理删除另立 phase。
   */
  summonDecision?: SummonDecisionMetadata;
  /** Phase 873/874: persisted terminal intent for recovery routing. */
  terminalState?: 'done' | 'failed';
}

// phase 1863 (AT-D7): 去 standard/shadow discriminated union——mode 降为 opaque 可选字段
// （ATS 不再枚举上层模式；legacy 'standard'/'shadow' 值读取容忍、不解释）。
export type SubAgentTask = CommonSubAgentTaskFields & { intent: string; mode?: string };

/**
 * phase 1863 (AT-D5)：执行/交付 runtime 上下文——核心基础设施（fs/audit/clawDir），由 ATS 转交。
 */
export interface TaskExecutionRuntime {
  readonly fs: FileSystem;
  readonly fsFactory: (baseDir: string) => FileSystem;
  readonly auditWriter: AuditLog;
  readonly clawDir: string;
}

/** phase 1863 (AT-D5)：单次执行产出（成败经 typed outcome 返回、不抛控制流）。 */
export interface TaskExecutionOutcome {
  readonly content: string;
  readonly sourceIsError: boolean;
  /** 失败分类（classifyTaskError 产物；成功时缺省）。 */
  readonly errorCategory?: string;
}

/**
 * phase 1863 (AT-D5)：最小执行面——ATS 只持有并调用；业务装配（LLM/registry/runSubagent/
 * payload 解释）归 executor 实现方（owner 侧 adapter，装配期注入）。
 */
export interface TaskExecutor {
  execute(task: SubAgentTask, signal: AbortSignal, runtime: TaskExecutionRuntime): Promise<TaskExecutionOutcome>;
}

/** phase 1863 (AT-D5)：交付 runtime 上下文（核心基础设施；writeInboxAsync 绑在 sink 构造）。 */
export interface TaskDeliveryRuntime {
  readonly fs: FileSystem;
  readonly auditWriter: AuditLog;
}

/**
 * phase 1863 (AT-D5)：最小交付面——subagent envelope 投递；失败抛错由调用方留 running。
 */
export interface DeliverySink {
  deliver(task: SubAgentTask, envelope: ProcessedTaskResult, runtime: TaskDeliveryRuntime): Promise<void>;
}

/**
 * phase 1863 (AT-D7)：executor payload 解释结果——owner 语义映射为通用执行参数。
 */
export interface ExecutorPayloadInterpretation {
  /** runSubagent prompt（缺省 = task.intent）。 */
  readonly prompt?: string;
  /** 覆盖默认 subagent systemPrompt。 */
  readonly systemPrompt?: string;
  /** 直接传给 runSubagent 的消息序列。 */
  readonly messages?: Message[];
  /** 受限工具覆盖（foundation applyRestrictedOverrides；如 shadow 子代理的受限 registry）。 */
  readonly applyRestrictedOverrides?: boolean;
  /** 结果捕获工具名（缺省走 runSubagent 默认）。 */
  readonly resultTool?: string;
}

/**
 * phase 1863 (AT-D7)：executor payload 解释面——owner 提供、装配期注入；
 * 返回 undefined = 无 payload 语义（standard 路径）。
 */
export type ExecutorPayloadAdapter = (payload: unknown) => ExecutorPayloadInterpretation | undefined;

/**
 * Phase 1206 Step A: prepared identity submission input.
 * Caller provides the canonical full ID and payload; AsyncTaskSystem owns
 * shortId derivation, canonical hash, and lifecycle directory lookup.
 */
export interface PreparedSubagentSchedule {
  id: FullTaskId;
  createdAt: string;
  payload: Omit<SubAgentTask, 'id' | 'shortId' | 'createdAt'>;
}

export interface PreparedScheduleResult {
  taskId: FullTaskId;
  disposition: 'created' | 'existing';
}

/** Consumer capability for scheduling a typed subagent task. */
export interface SubAgentTaskScheduler {
  schedule(
    taskKind: 'subagent',
    payload: Omit<SubAgentTask, 'id' | 'shortId' | 'createdAt'>,
  ): Promise<ShortTaskId>;
}

/** Consumer capability for idempotent scheduling with caller-prepared identity. */
export interface PreparedSubAgentTaskScheduler {
  schedulePrepared(
    taskKind: 'subagent',
    prepared: PreparedSubagentSchedule,
  ): Promise<PreparedScheduleResult>;
}

/**
 * Phase 1814 Step B（AT-D3）：shutdown/abort 生命周期 typed outcome。
 *
 * - `converged`：drain 后无未 settle 的内存执行句柄；`aborted` 为本次发出的
 *   abort 信号数，`terminal` 为 shutdown 开始时在途、现已 settle 的句柄 identity。
 * - `timed_out`：drain（含 grace）后仍有未 settle 句柄——`pending` 是未收敛
 *   identity 证据。注意：pending 仅表示内存句柄未观察 settle，**不得**由
 *   此推断磁盘终态（fs running 目录才是 running 权威状态）。
 * - `already_shutting_down`：重入幂等（phase 546 guard），不重复 abort/drain。
 */
export type TaskLifecycleOutcome =
  | { kind: 'converged'; aborted: number; terminal: readonly FullTaskId[] }
  | { kind: 'timed_out'; pending: readonly FullTaskId[]; terminal: readonly FullTaskId[] }
  | { kind: 'already_shutting_down' };

/** Phase 1814 Step B（AT-D3）：abort 请求证据——发出信号的句柄 identity。 */
export interface AbortRequestOutcome {
  kind: 'abort_requested';
  taskIds: readonly FullTaskId[];
}

/** Runtime-owned lifecycle view of the asynchronous task engine. */
export interface AsyncTaskRuntimeLifecycle {
  initialize(): Promise<void>;
  startDispatch(): Promise<void>;
  shutdown(timeoutMs?: number): Promise<TaskLifecycleOutcome>;
  abort(): AbortRequestOutcome;
}

/**
 * Discriminator union of task kinds.
 * Used as Record key for executor strategy table (phase 16 Step B).
 */
export type TaskKind = SubAgentTask['kind'] | ToolTask['kind'];

/**
 * Strategy entry: dispatches the body of a task after movePendingToRunning.
 * Stored in AsyncTaskSystem.executors: Record<TaskKind, TaskDispatchFn>.
 * （phase 1863 AT-D5：原名 TaskExecutor；执行面接口 TaskExecutor 为装配注入的最小执行面）
 */
export type TaskDispatchFn = (
  task: SubAgentTask | ToolTask,
  signal: AbortSignal,
) => Promise<void>;

/**
 * Phase 1269 Step E: versioned persisted execution-group identity for
 * migrated exec tasks. New migrated writes MUST include this structure;
 * legacy `migratedPid`/`migratedStartTime` remain read-only compatible and
 * must never be guessed into a process-group identity (legacy processes were
 * not detached group leaders).
 */
interface MigratedExecutionV1 {
  version: 1;
  leaderPid: number;
  processGroupId: number;
  leaderStartTime?: string;
}

export interface ToolTask {
  kind: 'tool';
  id: TaskId;
  /** Phase 867: 8-char display ID persisted alongside full UUID id. */
  shortId: ShortTaskId;
  toolName: string;
  args: Record<string, unknown>;        // fs-persistable / 替代 callback closure
  parentClawDir: string;                // caller clawDir / ctx 重建用
  parentClawId: string;
  createdAt: string;
  isIdempotent: boolean;  // Determines if retry is allowed
  maxRetries: number;     // Max retry attempts (default 2)
  retryCount: number;     // Current retry count (initial 0)
  toolUseId?: ToolUseId;   // 对应 LLM tool_use block id，用于 tool_async_result

  /**
   * Phase 770: async exec migration mode.
   * 'fresh' = spawn new process via tool execute callback (default).
   * 'migrated' = monitor an already-running process identified by migratedPid.
   */
  mode?: 'fresh' | 'migrated';
  /** Phase 770: PID to monitor when mode='migrated'. Legacy read-only compat (phase 1269: superseded by migratedExecution). */
  migratedPid?: number;
  /**
   * Phase 770: process start time when mode='migrated'.
   * Format matches ProcessStartTime (ps lstart string) for PID reuse defense.
   * Legacy read-only compat (phase 1269: superseded by migratedExecution.leaderStartTime).
   */
  migratedStartTime?: string;
  /** Phase 1269: persisted execution-group identity for migrated exec (new writes). */
  migratedExecution?: MigratedExecutionV1;
  /** Phase 906: absolute deadline (ms) for migrated process hard timeout. */
  migratedDeadlineMs?: number;
  /** Phase 873/874: persisted terminal intent for recovery routing. */
  terminalState?: 'done' | 'failed';
}
