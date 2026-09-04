/**
 * @module L6.CLI.Claw.Daemon
 * Start the Claw daemon (auto-backgrounds).
 *
 * Extracted from `cli/index.ts` action lambda (phase 1421) to:
 *  - restore SRP (action wrapper only wires CLI args)
 *  - enable processManager DI for tests (no vi.mock on dynamic await import)
 */

import { getWorkspaceRoot } from '../../core/claw-topology/index.js';
import { resolveClawDaemonDir } from '../../core/claw-topology/index.js';
import { getChestnutRoot, getClawDir, getClawConfigPath } from '../../core/claw-topology/index.js';
import { createSystemAudit } from '../../foundation/audit/index.js';
import { createAgentProcessManager } from '../../foundation/process-manager/index.js';
import { makeClawId } from '../../foundation/claw-identity/index.js';
import type { ProcessManager } from '../../foundation/process-manager/index.js';
import { CliError } from '../errors.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { CLI_AUDIT_EVENTS } from '../audit-events.js';
import { createDaemonSpawnOptions } from '../../daemon/index.js';
import type { ClawCommandDeps } from './claw-command-deps.js';

// phase 1773: liveness typed protocol——boolean convenience（单一 probe 的单行投影）
export type DaemonPM = Pick<ProcessManager, 'isAlive' | 'spawn'>;

export interface ClawDaemonDeps extends ClawCommandDeps {
  /** Test seam — when provided, skips real ProcessManager construction. */
  processManager?: DaemonPM;
}

export async function clawDaemonCommand(
  deps: ClawDaemonDeps,
  name: string,
  extraDeps?: { audit?: AuditLog },
): Promise<void> {
  deps.rootConfig.loadGlobal();
  const configPath = getClawConfigPath(name);
  if (deps.rootConfig.loadClaw(configPath) === undefined) {
    throw new CliError(`Claw "${name}" does not exist. Try \`chestnut claw list\` to see existing claws.`);
  }
  const clawDir = getClawDir(name);
  const baseDir = getChestnutRoot();
  const nodeFs = deps.fsFactory(baseDir);
  const systemAudit = createSystemAudit(nodeFs, baseDir);
  const pm: DaemonPM = deps.processManager
    ?? createAgentProcessManager({ fsFactory: deps.fsFactory, baseDir }, systemAudit);
  const clawId = makeClawId(name);
  if (pm.isAlive(resolveClawDaemonDir(clawId))) {
    console.warn(`⚠ Claw "${name}" is already running`);
    return;
  }
  // Phase 1464 Step B: spawn specification 归 Daemon 唯一 owner，CLI 只提交 identity/agentDir/workspaceRoot
  const pid = await pm.spawn(resolveClawDaemonDir(clawId), createDaemonSpawnOptions({
    clawId,
    agentDir: clawDir,
    workspaceRoot: getWorkspaceRoot(),
  }));
  // phase 1452 Step B: spawn 成功侧 emit（对齐 start.ts DAEMON_START 形态）；
  // 失败侧由 PM PROCESS_SPAWN_FAILED 承载（豁免、不补 CLI 侧失败事件）
  extraDeps?.audit?.write(CLI_AUDIT_EVENTS.CLAW_DAEMON_START, `claw=${name}`, `pid=${pid}`);
  console.log(`Started Claw "${name}" (PID: ${pid})`);
}
