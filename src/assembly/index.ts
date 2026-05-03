/**
 * @module L6c.Assembly
 * Assembly — 运行时依赖组装与注入。
 */

import type { AuditWriter } from '../foundation/audit/writer.js';
import type { Snapshot } from '../foundation/snapshot/index.js';
import type { StreamWriter } from '../foundation/stream/writer.js';
import type { ProcessManager } from '../foundation/process-manager/manager.js';
import type { ClawRuntime, Heartbeat } from '../core/runtime/index.js';
import type { CronRunner } from '../core/cron/index.js';
import type { ClawGlobalConfig, ClawConfig } from '../foundation/config/index.js';
import type { Gateway } from '../core/gateway/types.js';

export type Identity = 'motion' | 'claw';

export interface AssembleConfig {
  readonly identity: Identity;
  readonly clawId: string;
  readonly clawDir: string;
  readonly globalConfig: ClawGlobalConfig;
  readonly clawConfig: ClawConfig | null;  // identity='claw' 必填；'motion' 为 null
}

export interface Instances {
  readonly clawId: string;
  readonly runtime: ClawRuntime;
  readonly streamWriter: StreamWriter;
  readonly snapshot: Snapshot;
  readonly processManager: ProcessManager;
  readonly auditWriter: AuditWriter;
  readonly cronRunner?: CronRunner;   // motion + config.cron.enabled
  readonly heartbeat?: Heartbeat;     // motion + heartbeat_interval_ms > 0
  readonly gateway?: Gateway;          // motion only, offline mode（phase157）
}

export { LockConflictError } from '../foundation/process-manager/index.js';

export { assemble } from './assemble.js';
export { disassemble } from './disassemble.js';
