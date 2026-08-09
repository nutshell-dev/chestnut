/**
 * @module L4.Runtime.Types
 * Runtime interface types — 1:1 保 runtime.ts:47-126 body
 */

import type { FileSystem } from '../../foundation/fs/index.js';
import type { LLMOrchestrator } from '../../foundation/llm-orchestrator/index.js';
import type { LLMOrchestratorConfig } from '../../foundation/llm-orchestrator/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { SnapshotCommitter } from '../../foundation/snapshot/index.js';
import type { DialogSessionLifecycle } from '../../foundation/dialog-store/index.js';
import type { InboxReader, InboxMessageTypeRegistry } from '../../foundation/messaging/index.js';

import type { ToolRegistry } from '../../foundation/tools/index.js';
import type { IToolExecutor } from '../../foundation/tools/index.js';
import type { ContextInjector } from '../context_manager/index.js';
import type { SkillContextSource } from '../../foundation/skill-system/index.js';
import type { ContractRuntimeLifecycle } from '../contract/index.js';
import type { AsyncTaskRuntimeLifecycle } from '../async-task-system/index.js';
import type { PermissionChecker } from '../../foundation/tool-protocol/index.js';

import type { ToolProfile } from '../../foundation/tool-protocol/index.js';

import type { ContextManagerRuntimeConfig } from '../step-executor/index.js';
import type { InboxMessage } from '../../foundation/messaging/index.js';



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

/** 1:1 保 runtime.ts:47-72 body */
export interface RuntimeDependencies {
  // === L1 ===
  readonly systemFs: FileSystem;

  // === L2 ===
  readonly auditWriter: AuditLog;
  readonly snapshot: SnapshotCommitter;
  readonly sessionManager: DialogSessionLifecycle;
  readonly inboxReader: InboxReader;

  // === L3-L5 ===
  readonly llm: LLMOrchestrator;
  readonly toolRegistry: ToolRegistry;
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

  // 构造期注入（phase182 B.p166-5 升档：setter 双阶段消除）
  readonly parentStreamLog?: import('../../foundation/stream/index.js').StreamLog;

  /** phase 521: regime 切换协调装配 / Assembly own factory / per L5.G1-G4 closure 2026-05-07 */
  readonly dialogStoreFactory: () => DialogSessionLifecycle;

  /** phase 1414: inbox 消息 formatter 注册表（Assembly 装配期填、各业主自家 formatter）*/
  readonly formatterRegistry: InboxMessageTypeRegistry;

  /** phase 69: L6 Assembly 装配期注入 claw 子目录列表（mkdir on init/regime switch） */
  readonly clawSubdirs: readonly string[];

  /**
   * phase 27 Step D P5: guidance compose callback hook、替代直接 import L6 type。
   * Assembly 注入实际 composer（基于 MotionGuidanceRegistry）、Runtime 仅调用 callback。
   */
  readonly guidanceCompose?: GuidanceCompose;
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
  contextManagerConfig?: ContextManagerRuntimeConfig;
}

export type { StreamCallbacks } from '../agent-executor/index.js';

export interface TurnResult {
  status: 'success' | 'failed' | 'interrupted';
  error?: unknown;
  cause?: string;
}

export interface PendingTurnFacts {
  addressed: InboxMessage[];
  controls: InboxMessage[];
}
