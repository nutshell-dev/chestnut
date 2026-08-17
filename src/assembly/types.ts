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
  /** Phase 1396 Step E: EventLoop 执行停滞恢复的 probe/sink（daemon 传给 EventLoop）。 */
  readonly executionRecovery?: EventLoopExecutionRecoveryDeps;
  /** Dispose exactly the private resources constructed for this assembly session. */
  readonly dispose: (signal: string) => Promise<void>;
}
