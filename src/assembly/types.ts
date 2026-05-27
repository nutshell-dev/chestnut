import type { AuditLog } from '../foundation/audit/index.js';
import type { Snapshot } from '../foundation/snapshot/index.js';
import type { StreamWriter } from '../foundation/stream/index.js';
import type { ProcessManager } from '../foundation/process-manager/index.js';
import type { Runtime, Heartbeat } from '../core/runtime/index.js';
import type { CronRunner } from '../core/cron/index.js';
import type { ClawGlobalConfig, ClawConfig } from '../foundation/config/index.js';
import type { Gateway } from '../core/gateway/index.js';
import type { EvolutionSystem } from '../core/evolution-system/index.js';
import type { ClawId } from '../foundation/identity/index.js';
import type { Messaging } from '../foundation/messaging/index.js';
import { type ClawDir } from '../foundation/identity/index.js';


export type Identity = 'motion' | 'claw';

export interface AssembleConfig {
  readonly identity: Identity;
  readonly clawId: ClawId;
  readonly clawDir: ClawDir;
  readonly globalConfig: ClawGlobalConfig;
  readonly clawConfig: ClawConfig | null;  // identity='claw' 必填；'motion' 为 null
}

export interface Instances {
  readonly clawId: ClawId;
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
  /** Phase 1373 sub-1: Messaging instance for shutdown-time final outbox drain */
  readonly messaging?: Messaging;
}
