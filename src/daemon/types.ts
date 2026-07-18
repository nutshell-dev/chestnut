/**
 * @module L6.Daemon
 * Daemon-internal type definitions — decoupled from Assembly.
 */

import type { Runtime } from '../core/runtime/index.js';
import type { Heartbeat } from '../core/heartbeat/index.js';
import type { StreamWriter } from '../foundation/stream/index.js';
import type { Snapshot } from '../foundation/snapshot/index.js';
import type { ProcessManager } from '../foundation/process-manager/index.js';
import type { AuditLog } from '../foundation/audit/index.js';


/**
 * Runtime instances required by the daemon loop.
 * Structural subset of Assembly's Instances (decoupled in phase1101).
 */
export interface DaemonInstances {
  readonly clawId: string;
  readonly runtime: Runtime;
  readonly streamWriter: StreamWriter;
  readonly snapshot: Snapshot;
  readonly processManager: ProcessManager;
  readonly auditWriter: AuditLog;
  readonly heartbeat?: Heartbeat;
}
