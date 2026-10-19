/**
 * DialogStore types (L2)
 *
 * Session data structure for current.json persistence.
 */

import type { ToolDefinition } from '../llm-provider/index.js';
import type { Message } from './canonical-message.js';
import type { TraceId } from '../audit/index.js';



export interface SessionData {
  version: number;          // bump to 2 (phase 713)
  clawId?: string;          // phase 450: 可选 / subagent ephemeral 用例 0 clawId
  createdAt: string;
  updatedAt: string;
  systemPrompt: string;     // phase 713: per-turn latest snapshot
  messages: Message[];
  toolsForLLM: ToolDefinition[];  // phase 713 NEW
  /** phase 1343 α-6: turn-level trace id for cross-module audit correlation */
  trace_id?: TraceId;
}

/** Phase 987: discriminated union — io_error carries no session so callers must narrow. */
export type LoadResult =
  | { source: 'current' | 'archive' | 'empty'; session: SessionData }
  | { source: 'io_error'; error: string; session: null };

/**
 * phase 1816 (load-stable-exhaustion-downgrades): 稳定入口（loadStable /
 * loadStableTurnBoundary）结果 = 普通 LoadResult + 显式 unstable 分支。
 * mtime 一致性重试耗尽不得退回普通 load() 把无法确认稳定的状态伪装成成功——
 * unstable 携带 attempts 证据、session 为 null，caller 必须 narrow 处理。
 */
export type StableLoadResult =
  | LoadResult
  | { source: 'unstable'; attempts: number; session: null };

/** Dialog session snapshot accepted by the DialogStore persistence boundary. */
export interface DialogSaveSnapshot {
  systemPrompt: string;
  messages: Message[];
  toolsForLLM: ToolDefinition[];
  trace_id?: TraceId;
}

/**
 * phase 1850 Step C: save() 在 owner 内 clone 上分配的 blockId 显式回传单元。
 * caller 持有对象在 save 前后完全不变；需要 in-memory blockId 的 caller 用
 * applyBlockIdAssignments 把 assignments 写回自己的 messages 数组。
 */
export interface BlockIdAssignment {
  messageIndex: number;
  blockIndex: number;
  blockId: string;   // full UUID
  shortId: string;   // uuidToShort(blockId)
}

/**
 * phase 1850 Step B: save 双文件提交协议的结构化交付。
 * 主快照（current.json）失败 = reject（无部分提交）；index 失败 = 主快照已提交的事实不丢，
 * 以 blockIndexPersisted=false 回传（dirty 保持、下次 save 自动重试），不 reject。
 */
export interface DialogSaveResult {
  /** 主快照（current.json）提交后，block-index 是否已同步持久化；false 时 dirty 保持、下次 save 重试 */
  blockIndexPersisted: boolean;
  /** phase 1850 Step C: 本次 save 在内部 clone 上新分配的 blockId 清单（幂等：已带 ID 的块不在列） */
  assignedBlockIds: BlockIdAssignment[];
}

/**
 * Minimal lifecycle required by a dialog-session consumer.
 *
 * DialogStore owns the persistence semantics; consumers depend on this protocol
 * instead of the concrete store and its unrelated lookup/restore capabilities.
 */
export interface DialogSessionLifecycle {
  /** 本 session 的 dialog 目录绝对路径（owner 资源位置；recovery/取证 artifact 派生用） */
  readonly dialogDir: string;
  load(): Promise<LoadResult>;
  save(snapshot: DialogSaveSnapshot): Promise<DialogSaveResult>;
  beginTurn(): Promise<void>;
  commitTurn(reason?: string): Promise<void>;
  rollbackTurn(reason?: string): Promise<void>;
  archive(): Promise<void>;
  /**
   * Phase 1955 Step C：turn 内 step checkpoint / 工具副作用 journal 持久化能力。
   * 可选：测试窄 mock 无此面时 Runtime 按旧 all-or-nothing 语义运行。
   */
  readonly turnRecovery?: TurnRecoveryPersistence;
}

/** turn 内单个工具调用的持久事实（RecoveryDelivery 的 dialog-store 侧形态）。 */
export interface TurnToolUseJournalFact {
  toolUseId: string;
  toolName: string;
  status: 'started' | 'completed';
  startedAt: string;
  completedAt?: string;
  success?: boolean;
  /** 工具结果正文（恢复时复用、不重复执行副作用）。 */
  content?: string;
  /** 失败结果的错误原因摘要。 */
  error?: string;
}

/** 已完成 step 的 durable checkpoint（引用同一 transaction 与 dialog 修订身份）。 */
export interface TurnStepCheckpoint {
  transactionId: string;
  stepIndex: number;
  dialogRevision: string;
  completedToolUses: ReadonlyArray<{
    toolUseId: string;
    toolName: string;
    completedAt: string;
    success: boolean;
  }>;
  committedAt: string;
}

/**
 * Phase 1955 Step C：DialogStore 侧的 turn 恢复持久化协议。
 * 不依赖 L3 StepExecutor——由 Runtime 把 RecoveryDelivery 事实适配到本接口，
 * 保持 L2 不反向依赖 L3。
 */
export interface TurnRecoveryPersistence {
  /** 完整 LLM 响应已收到的严格提交点（副作用前）。 */
  recordLlmResponse(fact: {
    committedAtMs: number;
    stopReason: string;
    content: unknown;
  }): Promise<void>;
  /** 工具意图（executor 副作用前）持久化。 */
  recordToolStarted(fact: {
    toolUseId: string;
    toolName: string;
    input: Record<string, unknown>;
    startedAtMs: number;
  }): Promise<void>;
  /** 工具结果（副作用返回后即刻）持久化。 */
  recordToolResult(fact: {
    toolUseId: string;
    toolName: string;
    success: boolean;
    content?: string;
    error?: string;
    resultAtMs: number;
  }): Promise<void>;
  /** step 完成边界：固化 checkpoint（调用方保证 dialog 已先持久化）。 */
  checkpointTurn(stepIndex: number): Promise<void>;
  /**
   * 部分提交：保留当前 dialog 与 checkpoint，不再回滚整轮。
   * @returns false = 尚无 checkpoint（调用方回落到 rollback 语义）
   */
  commitPartial(reason: string): Promise<boolean>;
}

