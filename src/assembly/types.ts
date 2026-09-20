import type { AuditLog } from '../foundation/audit/index.js';
import type { Snapshot } from '../foundation/snapshot/index.js';
import type { StreamWriter } from '../foundation/stream/index.js';
import type { ProcessManager } from '../foundation/process-manager/index.js';
import type { Runtime } from '../core/runtime/index.js';
import type { Heartbeat } from '../core/heartbeat/index.js';
import type { EventLoopExecutionRecoveryDeps } from '../core/event-loop/index.js';
import type { ClawGlobalConfig, ClawConfig } from './config/compose-config.js';
import type { createSkillSystem as defaultCreateSkillSystem } from '../foundation/skill-system/index.js';
import type { InboxMessageTypeDeclaration } from '../foundation/messaging/index.js';
import type { AuditFileRoutingContribution } from '../foundation/audit/index.js';

export type Identity = 'motion' | 'claw';

export interface AssembleOverrides {
  createSkillSystem?: typeof defaultCreateSkillSystem;
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
