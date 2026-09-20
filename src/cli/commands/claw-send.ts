/**
 * @module L6.CLI.Claw.Send
 * Send an inbox message to a Claw
 */

import * as path from 'path';

import { getChestnutRoot, getClawConfigPath, getRelativeClawDir } from '../../foundation/claw-identity/index.js';
import { CliError } from '../errors.js';
import { makeClawNotifyTargetResolver } from '../../core/claw-topology/index.js';
import { createClawNotifier } from '../../foundation/messaging/index.js';
import { formatNoActiveContractHint } from './claw-shared.js';
import { formatClawStatusHint } from '../../cli-protocol/index.js';
import type { Priority } from '../../foundation/messaging/index.js';
import { actionAuditFor } from '../action-scope.js';

import { createProcessManagerForCLI } from '../../foundation/process-manager/index.js';
import { resolveClawDaemonDir } from '../../core/claw-topology/index.js';
import { makeClawId } from '../../foundation/claw-identity/index.js';
import { hasActiveContract } from '../../core/contract/index.js';
import type { ClawCommandDeps } from './claw-command-deps.js';

export async function sendCommand(
  deps: ClawCommandDeps,
  name: string, 
  message: string, 
  options?: { priority?: Priority }
): Promise<void> {
  deps.rootConfig.loadGlobal();
  
  const configPath = getClawConfigPath(name);
  if (deps.rootConfig.loadClaw(configPath) === undefined) {
    throw new CliError(`Claw "${name}" does not exist`);
  }

  const baseDir = getChestnutRoot();
  const clawDir = path.join(baseDir, getRelativeClawDir(name));
  const fileSystem = deps.fsFactory(baseDir);
  const audit = actionAuditFor(clawDir, deps);

  // phase 1864 Step C（CT-D2）：发送归 Messaging；位置经拓扑 resolver 注入。
  createClawNotifier({
    fs: fileSystem,
    audit,
    resolveTarget: makeClawNotifyTargetResolver(baseDir),
  }).notify(name, {
    type: 'user_inbox_message',
    source: 'user',
    priority: options?.priority ?? 'normal',
    body: message,
  });

  console.log(`Message sent to "${name}"`);

  const processManager = createProcessManagerForCLI({ ...deps, baseDir });
  const isAlive = processManager.isAlive(resolveClawDaemonDir(makeClawId(name)));
  const statusHint = formatClawStatusHint(name, isAlive);
  if (statusHint) console.log(statusHint);

  // phase 241: active contract hint — no active contract → remind caller
  const clawFs = deps.fsFactory(clawDir);
  let hasContract = false;
  try {
    hasContract = hasActiveContract(clawFs, '.');
  } catch {
    // silent: contract dir scan failure is legitimate → treat as no active contract
    hasContract = false;
  }
  const contractHint = formatNoActiveContractHint(name, hasContract);
  if (contractHint) console.log(contractHint);
}
