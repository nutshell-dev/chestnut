/**
 * @module L6.Daemon
 * Daemon-internal type definitions — decoupled from Assembly.
 */

import type { Runtime, Heartbeat } from '../core/runtime/index.js';
import type { StreamWriter } from '../foundation/stream/index.js';
import type { Snapshot } from '../foundation/snapshot/index.js';
import type { ProcessManager } from '../foundation/process-manager/index.js';
import type { AuditLog } from '../foundation/audit/index.js';
import type { ClawId } from '../foundation/identity/index.js';


/**
 * Runtime instances required by the daemon loop.
 * Structural subset of Assembly's Instances (decoupled in phase1101).
 */
export interface DaemonInstances {
  readonly clawId: ClawId;
  readonly runtime: Runtime;
  readonly streamWriter: StreamWriter;
  readonly snapshot: Snapshot;
  readonly processManager: ProcessManager;
  readonly auditWriter: AuditLog;
  readonly heartbeat?: Heartbeat;
}
