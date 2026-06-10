/**
 * @module L6.CLI.Claw.Send
 * Send an inbox message to a Claw
 */

import * as path from 'path';

import {
  loadGlobalConfig, clawExists, getGlobalConfigPath, getClawConfigPath,
} from '../../foundation/config/index.js';
import { CliError } from '../errors.js';
import type { FileSystem } from '../../foundation/fs/types.js';
import { notifyClaw } from '../../foundation/messaging/notify.js';
import { formatClawStatusHint } from './claw-shared.js';
import { createSystemAudit } from '../../foundation/audit/index.js';
import { CLAWS_DIR } from '../../assembly/claw-dirs.js';
import { createProcessManagerForCLI } from '../../foundation/process-manager/index.js';
import { makeClawId } from '../../constants.js';

export async function sendCommand(
  deps: { fsFactory: (baseDir: string) => FileSystem },
  name: string, 
  message: string, 
  options?: { priority?: 'critical' | 'high' | 'normal' | 'low' }
): Promise<void> {
  loadGlobalConfig(deps);
  
  const configPath = getClawConfigPath(name);
  if (!clawExists(deps, configPath)) {
    throw new CliError(`Claw "${name}" does not exist`);
  }

  const globalConfigPath = getGlobalConfigPath();
  const baseDir = path.dirname(globalConfigPath);
  const clawDir = path.join(baseDir, CLAWS_DIR, name);
  const fileSystem = deps.fsFactory(baseDir);
  const audit = createSystemAudit(fileSystem, clawDir);

  notifyClaw(fileSystem, baseDir, name, {
    type: 'user_inbox_message',
    source: 'user',
    priority: options?.priority ?? 'normal',
    body: message,
  }, audit);

  console.log(`Message sent to "${name}"`);

  const processManager = createProcessManagerForCLI(deps);
  const isAlive = processManager.isAlive(makeClawId(name));
  const statusHint = formatClawStatusHint(name, isAlive);
  if (statusHint) console.log(statusHint);
}
