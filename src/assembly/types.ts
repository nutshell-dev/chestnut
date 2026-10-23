import type { AuditLog } from '../foundation/audit/index.js';
import type { Snapshot } from '../foundation/snapshot/index.js';
import type { StreamWriter } from '../foundation/stream/index.js';
import type { DaemonDir, ProcessManager, SpawnOptions } from '../foundation/process-manager/index.js';
import type { FileSystem } from '../foundation/fs/index.js';
import type { ClawId, ChestnutRoot } from '../foundation/claw-identity/index.js';
import type { ExecutorHeartbeatRead } from '../core/contract/index.js';
import type { Runtime } from '../core/runtime/index.js';
import type { AppliedLLMIdentityPublishOutcome } from '../core/runtime/index.js';
import type { Heartbeat } from '../core/heartbeat/index.js';
import type { EventLoopExecutionRecoveryDeps, EventLoop } from '../core/event-loop/index.js';
import type { ClawGlobalConfig, ClawConfig } from './config/compose-config.js';
import type { createSkillSystem as defaultCreateSkillSystem } from '../foundation/skill-system/index.js';
import type { createSkillVersions as defaultCreateSkillVersions } from '../foundation/skill-system/index.js';
import type { InboxMessageTypeDeclaration } from '../foundation/messaging/index.js';
import type { AuditFileRoutingContribution } from '../foundation/audit/index.js';

export type Identity = 'motion' | 'claw';

export interface AssembleOverrides {
  createSkillSystem?: typeof defaultCreateSkillSystem;
  /** Phase 1919 Step B：dispatch 版本服务工厂（测试注入 mock，避免真实嵌套 Git） */
  createSkillVersions?: typeof defaultCreateSkillVersions;
}

/**
 * phase 1243 Step B: production contributions passed into Assembly by the external lifecycle caller.
 * These are static declarations, not test overrides; they must not be mixed with AssembleDeps.
 */
export interface AssemblyContributions {
  readonly auditFileRouting?: readonly AuditFileRoutingContribution[];
  readonly inboxMessageTypes?: readonly InboxMessageTypeDeclaration[];
}

interface AssembleConfigBase {
  readonly clawId: string;
  readonly clawDir: string;
  readonly globalConfig: ClawGlobalConfig;
  /** Phase 1204 Step C: parent 传入的 spawn generation identity（env CHESTNUT_PROCESS_GENERATION）。 */
  readonly processGenerationId?: string;
  /**
   * Phase 1945 Step C：热重载成功后发布「已应用」LLM 身份的工厂（motion daemon 注入；
   * claw 缺省 = 无发布语义）。Daemon own 事实 schema 与发布时机语义；Assembly 只负责
   * 把 PM/daemonDir 绑定进去（不 import daemon 模块，避免 daemon → assembly → daemon cycle）。
   */
  readonly createAppliedLLMIdentityPublisher?: (
    pm: ProcessManager,
    daemonDir: DaemonDir,
  ) => (identity: string) => Promise<AppliedLLMIdentityPublishOutcome>;
  /**
   * Phase 1974 Step B：executor daemon 监督所需的 daemon 协议 capability（motion-only）。
   * Daemon own spawn 规格（entry/argv/env/cwd/log 协议）与心跳事实协议；Assembly
   * 只负责绑定 PM/clawDir/ClawTopology（不 import daemon 模块——phase 1243 Step F
   * Assembly→Daemon 依赖方向 ratchet）。缺省时 executor-supervisor cron job 不注册
   * （同 createAppliedLLMIdentityPublisher 可选注入先例）。
   */
  readonly executorDaemonProtocol?: ExecutorDaemonProtocol;
}

/** Phase 1974 Step B：daemon 协议 capability（实现归 Daemon owner，类型归 Assembly 输入面）。 */
export interface ExecutorDaemonProtocol {
  /** daemon spawn 规格构造（= createDaemonSpawnOptions 语义本体）。 */
  readonly createSpawnOptions: (input: {
    clawId: ClawId;
    agentDir: string;
    chestnutRoot: ChestnutRoot;
  }) => SpawnOptions;
  /** 读 daemon 心跳事实并收窄为三分 typed result（= readDaemonHeartbeat 语义本体）。 */
  readonly readHeartbeat: (agentDirFs: FileSystem) => ExecutorHeartbeatRead;
}

/**
 * phase 1872 Step B: 判别联合表达分支契约（此前 clawConfig 可空 + assemble 内
 * 运行时 throw 拦截）：
 * - identity='motion'：无 clawConfig（`never` 兜住结构性赋值绕过）；
 * - identity='claw'：clawConfig 必填。
 * 非法装配输入编译期拒绝，运行时检查退役。
 */
export type AssembleConfig =
  | (AssembleConfigBase & { readonly identity: 'motion'; readonly clawConfig?: never })
  | (AssembleConfigBase & { readonly identity: 'claw'; readonly clawConfig: ClawConfig });

export interface Instances {
  readonly runtime: Runtime;
  /** phase 1873 Step C: 装配期交付的 EventLoop（daemon 只驱动；构造/初始化归装配）。 */
  readonly eventLoop: EventLoop;
  readonly streamWriter: StreamWriter;
  readonly snapshot: Snapshot;
  readonly processManager: ProcessManager;
  readonly auditWriter: AuditLog;
  readonly heartbeat?: Heartbeat;     // motion + heartbeat_interval_ms > 0
  /** Phase 1396 Step E: EventLoop 执行停滞恢复的 probe/sink（daemon 传给 EventLoop）。 */
  readonly executionRecovery?: EventLoopExecutionRecoveryDeps;
  /** Phase 1826: 前台 LLM 恢复安排 session（daemon 把调度 capability 传给 EventLoop）。 */
  readonly recoverySession?: import('../foundation/llm-orchestrator/index.js').LLMRecoverySession;
  /** Dispose exactly the private resources constructed for this assembly session. */
  readonly dispose: (signal: string) => Promise<void>;
}
