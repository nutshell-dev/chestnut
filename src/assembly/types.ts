import type { AuditLog } from '../foundation/audit/index.js';
import type { Snapshot } from '../foundation/snapshot/index.js';
import type { StreamWriter } from '../foundation/stream/index.js';
import type { ProcessManager } from '../foundation/process-manager/index.js';
import type { Runtime } from '../core/runtime/index.js';
import type { Heartbeat } from '../core/heartbeat/index.js';
import type { ContractSystem } from '../core/contract/index.js';
import type { AsyncTaskSystem } from '../core/async-task-system/index.js';
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

export interface AssembleConfig {
  readonly identity: Identity;
  readonly clawId: string;
  readonly clawDir: string;
  readonly globalConfig: ClawGlobalConfig;
  readonly clawConfig: ClawConfig | null;  // identity='claw' 必填；'motion' 为 null
  /** Phase 1204 Step C: parent 传入的 spawn generation identity（env CHESTNUT_PROCESS_GENERATION）。 */
  readonly processGenerationId?: string;
}

export interface Instances {
  readonly runtime: Runtime;
  readonly streamWriter: StreamWriter;
  readonly snapshot: Snapshot;
  readonly processManager: ProcessManager;
  readonly auditWriter: AuditLog;
  readonly heartbeat?: Heartbeat;     // motion + heartbeat_interval_ms > 0
  /**
   * phase 1387 Step B: claw daemon waiting-stall escalated 后判失败取消 active 契约用。
   * motion identity 下 contractManager 走 motion-addons 独立生命周期、不在 Instances 暴露——
   * 该字段仅 claw assembly 返回，daemon-loop 仅 claw 路径消费（motion 无 active 契约）。
   */
  readonly contractManager?: ContractSystem;
  /**
   * phase 1388 Step B: claw daemon waiting-stall 第四路 skip——AsyncTaskSystem 在途查询。
   * motion identity 下不暴露（motion 无 async task）；该字段仅 claw assembly 返回。
   */
  readonly taskSystem?: AsyncTaskSystem;
  /** Dispose exactly the private resources constructed for this assembly session. */
  readonly dispose: (signal: string) => Promise<void>;
}
