/**
 * @module L4.AsyncTaskSystem.Types
 * Hub-level type exports to break circular imports within async-task-system.
 * Extracted in phase 1314 (cluster #3 of 5 cleanup roadmap).
 */

import type { Message, ToolDefinition } from '../../foundation/llm-provider/index.js';
import type { LLMOrchestrator } from '../../foundation/llm-orchestrator/index.js';
import type { OutboxWriter, InboxWriter } from '../../foundation/messaging/index.js';
import type { ContractSystem } from '../contract/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { ToolRegistry } from '../../foundation/tools/index.js';
import type { StreamLog } from '../../foundation/stream/index.js';
import type { DialogStore } from '../../foundation/dialog-store/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import type { PermissionChecker } from '../../foundation/tool-protocol/index.js';
import type { WatcherFactory } from '../../foundation/file-watcher/index.js';
import type { CallerType } from '../permissions/caller-types.js';
import type { ToolUseId } from '../../foundation/tool-protocol/index.js';
import type { SummonDecisionMetadata } from './task-schemas.js';

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

export function makeFullTaskId(s: string): FullTaskId { return s as FullTaskId; }
export function makeShortTaskId(s: string): ShortTaskId { return s as ShortTaskId; }
/** @deprecated Use makeFullTaskId or makeShortTaskId. */
export function makeTaskId(s: string): TaskId { return s as TaskId; }

/** Derive the shortId from any TaskId. For FullTaskId returns first 8 chars; for legacy 8-char ids returns as-is. */
export function deriveShortIdFromTaskId(taskId: TaskId): ShortTaskId {
  return makeShortTaskId(taskId.length === 36 ? taskId.slice(0, 8) : taskId);
}

/**
 * Return the canonical shortId for a task object.
 * Prefers the persisted `shortId` field; falls back to deriving from `id`
 * for pre-migration tasks or test fixtures.
 */
export function taskShortId(task: { id: TaskId; shortId?: ShortTaskId | string }): ShortTaskId {
  return task.shortId ? makeShortTaskId(task.shortId) : deriveShortIdFromTaskId(task.id);
}

export interface ShortIdIndex {
  needsRebuild: boolean;
  load(auditWriter?: { write: (event: string, payload: Record<string, unknown>) => void }): void;
  save(): void;
  has(shortId: string): boolean;
  add(
    shortId: ShortTaskId,
    fullId: FullTaskId,
    auditWriter?: { write: (event: string, payload: Record<string, unknown>) => void },
  ): void;
  delete(shortId: ShortTaskId): void;
  resolve(shortId: string): FullTaskId | undefined;
  reverseResolve(fullId: FullTaskId): ShortTaskId | undefined;
  deriveShortId(fullId: FullTaskId): ShortTaskId;
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

  llm: LLMOrchestrator;
  contractManager: ContractSystem;
  outboxWriter: OutboxWriter;
  /**
   * Self inbox for overflow notification (本 daemon 自家 inbox).
   * phase 37: rename from `motionInbox` 命名 hygiene (实际是本 daemon 自家、
   * worker case 不写 motion inbox)。motion daemon: 写 motion 自家; worker daemon: 写 worker 自家.
   */
  selfInbox?: InboxWriter;
  // main dialog store ref for subagent context restoration
  mainDialogStore?: DialogStore;
  registry: ToolRegistry;     // NEW: caller 注入填充好的 registry / Assembly own 装配
  /** Tool-level wall-clock timeout inherited from globalConfig.tool_timeout_ms (phase 1029 / F-2) */
  toolTimeoutMs?: number;
  permissionChecker?: PermissionChecker;
  fsFactory: (baseDir: string) => FileSystem;
  // NEW phase 1369: AskMotionTool factory inject (per phase 619 caller DIP enforce template / cut async-task→summon reverse)
  askMotionToolFactory: (llm: LLMOrchestrator, motionDialogStore: DialogStore) => import('../../foundation/tools/index.js').Tool;
  /** phase 849: shortId ↔ fullId index for dual-key task IDs */
  shortIdIndex: ShortIdIndex;
  /** phase 86: optional WatcherFactory for DI (test mock injection) */
  createWatcher?: WatcherFactory;
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
  callerType?: CallerType;
  originClawId?: string;                   // 创建链路源头，传给子 SubAgent
  /**
   * Motion clawDir（仅 mining summon / phase 713 reframe）
   * subagent-executor 据此构造 motionDialogStore 注入 AskMotionTool
   * ask_motion.execute 内部 read motionDialogStore.load() 拿 summon 时刻 dialog snapshot
   * 全然一致性 reuse Motion runtime 实然 dialog snapshot（per phase 709 design）
   */
  motionClawDir?: string;
  postProcessor?: string;            // 声明式 post-processor 名称（registry lookup）
  mainContextSnapshot?: { clawId: string; toolUseId: ToolUseId };  // NEW marker mode
  systemPrompt?: string;                 // phase 546 internal field：caller-side specialized system prompt（agent 不可见 / 与 phase 470 砍 agent-facing spawn schema 不冲突 / fall-back DEFAULT_SUBAGENT_SYSTEM_PROMPT）
  // phase 1087：shadow async 上下文快照字段
  isShadow?: boolean;
  shadowSystemPrompt?: string;
  shadowToolsForLLM?: ToolDefinition[];
  // phase 281: summon decision 内嵌 metadata，随 task lifecycle 同步
  summonDecision?: SummonDecisionMetadata;
}

// phase 218: intent 在 both mode 都存在、shadow 独有 shadowMessages
export type SubAgentTask = CommonSubAgentTaskFields & { intent: string } & (
  | { mode: 'standard'; shadowMessages?: undefined }
  | { mode: 'shadow'; shadowMessages: Message[] }
);

/**
 * Discriminator union of task kinds.
 * Used as Record key for executor strategy table (phase 16 Step B).
 */
export type TaskKind = SubAgentTask['kind'] | ToolTask['kind'];

/**
 * Strategy entry: dispatches the body of a task after movePendingToRunning.
 * Stored in AsyncTaskSystem.executors: Record<TaskKind, TaskExecutor>.
 */
export type TaskExecutor = (
  task: SubAgentTask | ToolTask,
  signal: AbortSignal,
) => Promise<void>;

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
  /** phase 858：sourced from ExecContext.isShadow at schedule time */
  isShadow?: boolean;
  /**
   * Phase 770: async exec migration mode.
   * 'fresh' = spawn new process via tool execute callback (default).
   * 'migrated' = monitor an already-running process identified by migratedPid.
   */
  mode?: 'fresh' | 'migrated';
  /** Phase 770: PID to monitor when mode='migrated'. */
  migratedPid?: number;
  /**
   * Phase 770: process start time when mode='migrated'.
   * Format matches ProcessStartTime (ps lstart string) for PID reuse defense.
   */
  migratedStartTime?: string;
}

