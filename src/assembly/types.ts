import type { AuditLog } from '../foundation/audit/index.js';
import type { Snapshot } from '../foundation/snapshot/index.js';
import type { StreamWriter } from '../foundation/stream/index.js';
import type { ProcessManager } from '../foundation/process-manager/index.js';
import type { Runtime, Heartbeat } from '../core/runtime/index.js';
import type { CronRunner } from '../foundation/cron/index.js';
import type { ClawGlobalConfig, ClawConfig } from './config/compose-config.js';
import type { Gateway } from '../core/gateway/index.js';
import type { EvolutionSystem } from '../core/evolution-system/index.js';
import type { createSkillSystem as defaultCreateSkillSystem } from '../foundation/skill-system/index.js';

export type Identity = 'motion' | 'claw';

export interface AssembleDeps {
  createSkillSystem?: typeof defaultCreateSkillSystem;
}

export interface AssembleConfig {
  readonly identity: Identity;
  readonly clawId: string;
  readonly clawDir: string;
  readonly globalConfig: ClawGlobalConfig;
  readonly clawConfig: ClawConfig | null;  // identity='claw' 必填；'motion' 为 null
}

export interface Instances {
  readonly clawId: string;
  readonly runtime: Runtime;
  readonly streamWriter: StreamWriter;
  readonly snapshot: Snapshot;
  readonly processManager: ProcessManager;
  readonly auditWriter: AuditLog;
  readonly cronRunner?: CronRunner;   // motion + config.cron.enabled
  readonly heartbeat?: Heartbeat;     // motion + heartbeat_interval_ms > 0
  readonly gateway?: Gateway;          // motion only, offline mode（phase157）
  readonly evolutionSystem?: EvolutionSystem;  // motion only（phase411）
  /** Phase 1200: motion lifecycle end-of-life dispose hook for contractSystemCache */
  readonly disposeContractSystems?: () => Promise<void>;
  // phase 1476: messaging field 砍 — Messaging interface 退场（drain-outboxes 砍 + final drain 砍）
}
