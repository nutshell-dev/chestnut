/**
 * @module L4.Runtime.Types
 * Runtime interface types — 1:1 保 runtime.ts:47-126 body
 */

import type { FileSystem } from '../../foundation/fs/index.js';
import type { LLMOrchestrator, LLMRuntimeCapability } from '../../foundation/llm-orchestrator/index.js';
import type { LLMOrchestratorConfig } from '../../foundation/llm-orchestrator/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { SnapshotCommitter } from '../../foundation/snapshot/index.js';
import type { DialogSessionLifecycle } from '../../foundation/dialog-store/index.js';
import type { InboxDeliverySession, InboxMessageRenderingResolver } from '../../foundation/messaging/index.js';

import type { ToolRegistry, ToolRegistryRuntimeCapability } from '../../foundation/tools/index.js';
import type { IToolExecutor } from '../../foundation/tools/index.js';
import type { ContextInjector } from './injector.js';
import type { SkillContextSource } from '../../foundation/skill-system/index.js';
import type { ContractRuntimeLifecycle, ContractCloseOutcome } from '../contract/index.js';
import type { ContractTerminalFact } from '../contract/index.js';
import type { TrimRuntimePolicy } from '../context_manager/index.js';
import type { AsyncTaskRuntimeLifecycle, TaskLifecycleOutcome } from '../async-task-system/index.js';
import type { PermissionChecker } from '../../foundation/tool-protocol/index.js';

import type { ToolProfile } from '../../foundation/tool-protocol/index.js';

import type { InboxMessage } from '../../foundation/messaging/index.js';
import type { InboxHandle } from '../../foundation/messaging/index.js';
import type { Message } from '../../foundation/dialog-store/index.js';

/**
 * phase 1860 (RT-D6)：MemoryOnlyState 显式登记——以下 Runtime 实例内存态经设计决策
 * 不进入 checkpoint/恢复；登记即决策（DP「未经显式设计决策不得丢弃」）。
 * 恢复 SoT = DialogStore session + read-state 磁盘 + snapshot 提交（initialize 路径）：
 * - turnCount：进程内 turn 序号（audit context `turn-N`）；跨重启关联由 trace_id 承载。
 * - lastLLMCallAt：proactive trim 判据；重启归 0 = 首 turn 不触发顺手裁（runtime.ts by-design）。
 * - currentTraceId：per-turn 重设，不跨 turn 存活。
 */

/**
 * Phase 1847: 原始消息交接 —— 一条已领取（inflight）消息及其结算句柄。
 * handle 由 Messaging mint（branded），Runtime 只关联不伪造。
 */
export interface PreparedInboxEntry {
  readonly message: InboxMessage;
  readonly handle: InboxHandle;
}

/**
 * Phase 1847: Runtime.prepareInbox 的返回 —— 磁盘 inflight 消息的运行时视图。
 * 不是新持久队列，不代表智能体已收到；准备完成未格式化、未注入、未结算。
 */
export interface PreparedInboxBatch {
  readonly entries: readonly PreparedInboxEntry[];
}

/**
 * Phase 1847: Runtime.formatPreparedInbox 的返回 —— 已领取批次的注入数据。
 * 格式化是可失败的后续动作；任一拒绝则整体抛原 error（不返回不完整 injected）。
 */
export interface FormattedInboxBatch {
  readonly injected: Message[];
  readonly sources: Array<{ text: string; type: string }>;
  readonly count: number;
  readonly infos: InboxMessage[];
}



/**
 * phase 1256 Step A: guidance envelope — Runtime 格式化 inbox 时一次性持有的最小输入。
 *
 * 持久化消息已有的 `{ type, from, meta }` 原样穿过 Runtime callback boundary；
 * Assembly 不得从 meta 猜测或补写 from。字段 readonly（M#9 显式表达）。
 */
export interface GuidanceEnvelope {
  readonly type: string;
  readonly from: string;
  readonly meta: Readonly<Record<string, string>>;
}

/**
 * phase 27 Step D P5: guidance compose callback hook、替代直接 import L6 type。
 * Assembly 注入实际 composer（基于 MotionGuidanceRegistry）、Runtime 仅调用 callback。
 * phase 1256 Step A: 收窄为单一 envelope 入参（替 positional (type, state)、消除 from 丢失）。
 */
export type GuidanceCompose = (input: GuidanceEnvelope) => { text: string } | null;

/** phase 1860 (RT-D4)：stop join 结果（typed，不丢）——超时证据经 outcome 交付。 */
export interface RuntimeStopOutcome {
  readonly kind: 'converged' | 'timed_out';
  /** active dialog operation join 结果（'none' = 无在途）。 */
  readonly dialogJoin: 'none' | 'joined' | 'failed';
  /** AT-D3 typed 生命周期结果透传（timed_out 时含 pending identity 证据）。 */
  readonly tasks: TaskLifecycleOutcome;
  /** contract close outcome（RT-D5/Step E）。 */
  readonly contractClose: ContractCloseOutcome;
}

/** 1:1 保 runtime.ts:47-72 body */
export interface RuntimeDependencies {
  // === L1 ===
  readonly systemFs: FileSystem;

  // === L2 ===
  readonly auditWriter: AuditLog;
  readonly snapshot: SnapshotCommitter;
  readonly sessionManager: DialogSessionLifecycle;
  readonly inboxReader: InboxDeliverySession;

  // === L3-L5 ===
  /** phase 1860 (RT-D1)：Runtime 私有消费面——仅 getProviderInfo/resetLastSuccessProvider/reloadConfig/close 4 方法。 */
  readonly llm: LLMRuntimeCapability;
  /**
   * phase 1860：转发面——ExecContext/AgentExecutor 消费的完整编排面（stream/call 等）；
   * Runtime 不消费、仅传递（Assembly 注入同一对象）。
   */
  readonly llmOrchestrator: LLMOrchestrator;
  /** phase 1860 (RT-D1)：Runtime 私有消费面——仅 getForProfile/formatForLLM 2 方法。 */
  readonly toolRegistry: ToolRegistryRuntimeCapability;
  readonly toolExecutor: IToolExecutor;
  /** Phase 773: base registry with plain sync exec for subagent spawn paths. */
  readonly baseToolRegistry?: ToolRegistry;
  readonly contractManager: ContractRuntimeLifecycle;
  readonly taskSystem: AsyncTaskRuntimeLifecycle;
  readonly skillRegistry: SkillContextSource;

  // === L4 (phase 1273) ===
  readonly permissionChecker: PermissionChecker;  // required / 编译期 enforce M#9

  // phase 1283: fsFactory inject (M#3 file I/O resource unique ownership)
  readonly fsFactory: (baseDir: string) => FileSystem;

  /** phase 521: regime 切换协调装配 / Assembly own factory / per L5.G1-G4 closure 2026-05-07 */
  readonly dialogStoreFactory: () => DialogSessionLifecycle;

  /** phase 1414/1367: Assembly 装配完成的 inbox rendering 只读查询能力。 */
  readonly formatterRegistry: InboxMessageRenderingResolver;

  /**
   * phase 27 Step D P5: guidance compose callback hook、替代直接 import L6 type。
   * Assembly 注入实际 composer（基于 MotionGuidanceRegistry）、Runtime 仅调用 callback。
   */
  readonly guidanceCompose?: GuidanceCompose;

  /**
   * phase 1869 (Step G): 契约终态事实只读查询（1846 `readContractTerminalFact`）。
   * Runtime.prepareInbox 消费适用性判定用：execution_recovery 提醒的契约已终态 →
   * 不交付（ack 到 done/ + 审计）。目录为生命周期权威，只读、无缓存。
   * 生产装配必注入；未注入 = 判定面关闭（照常交付，测试/无契约查询场景）。
   * 查询失败 fail-open（照常交付 + FATAL 留证）——误丢唤醒机会代价大于一次
   * 可能过期的交付。
   */
  readonly contractTerminalFact?: (contractId: string) => Promise<ContractTerminalFact>;
}

/** 1:1 保 runtime.ts:74-101 body */
export interface RuntimeOptions {
  clawId: string;
  clawDir: string;
  llmConfig: LLMOrchestratorConfig;
  maxSteps?: number;
  toolProfile?: ToolProfile;
  maxConsecutiveParseErrors?: number;
  maxConsecutiveMaxTokensToolUse?: number;
  idleTimeoutMs: number;   // LLM stream idle timeout（0 = 禁用、由 config boundary resolve）

  /**
   * phase 320: LLM 配置热更新 reloader。Assembly 装配期注入；调时**重读磁盘**拿最新配置。
   * inbox 收到 `reload_llm_config` 消息时由 drainInbox 拦截路径调用、传给 llm.reloadConfig。
   * undefined → 拦截路径 silent skip + audit LLM_RELOAD_SKIPPED。
   */
  configReloader?: () => LLMOrchestratorConfig;

  dependencies: RuntimeDependencies;  // 必传（phase155B 起，字段随 phase155C 扩展）

  // Motion/claw 身份差异由 Assembly 按 identity 分支注入（phase266 消除 MotionRuntime subclass）
  systemPromptBuilder?: (params: {
    contextInjector: ContextInjector;
    systemFs: FileSystem;
    audit?: AuditLog;
  }) => Promise<string>;
  identityToolFilter?: (registry: ToolRegistry) => void;

  /** phase 521: regime 切换 messages 继承 strategy / default 'all' / per L5.G1+G2 */
  regimeSwitchStrategy?: 'all' | 'none' | 'last-turn';

  /** phase 1190：上下文管理器运行时配置（filterSubtypes 已移除） */
  /** Explicit Runtime-owned trim enablement; omitted/false disables trimming. */
  contextTrimmingEnabled?: boolean;

  /** phase 1861 (CM-D1)：裁剪规则注入面——缺省项回落模块常量默认值。 */
  contextTrimPolicy?: Partial<TrimRuntimePolicy>;
}

export interface TurnResult {
  status: 'success' | 'failed' | 'interrupted';
  error?: unknown;
  cause?: string;
}

export interface PendingTurnFacts {
  addressed: InboxMessage[];
  controls: InboxMessage[];
}
