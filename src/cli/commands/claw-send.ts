/**
 * @module L6.CLI.Claw.Send
 * Send an inbox message to a Claw
 */

import * as path from 'path';
import { randomUUID } from 'crypto';
import {
  loadGlobalConfig, clawExists, getGlobalConfigPath,
} from '../../foundation/config/index.js';
import { CONFIG_DEFAULTS } from '../../assembly/config-defaults.js';
import { CliError } from '../errors.js';
import type { FileSystem } from '../../foundation/fs/types.js';
import { writeInboxAsync } from '../../foundation/messaging/index.js';
import { createSystemAudit } from '../../foundation/audit/index.js';
import { CLAWS_DIR } from '../../foundation/paths.js';

export async function sendCommand(
  deps: { fsFactory: (baseDir: string) => FileSystem },
  name: string, 
  message: string, 
  options?: { priority?: 'critical' | 'high' | 'normal' | 'low' }
): Promise<void> {
  loadGlobalConfig(deps, CONFIG_DEFAULTS);
  
  if (!clawExists(deps, name)) {
    throw new CliError(`Claw "${name}" does not exist`);
  }

  const globalConfigPath = getGlobalConfigPath();
  const baseDir = path.dirname(globalConfigPath);
  const clawDir = path.join(baseDir, CLAWS_DIR, name);
  const fileSystem = deps.fsFactory(clawDir);
  const audit = createSystemAudit(fileSystem, clawDir);
  const inboxPendingRel = path.join('inbox', 'pending');

  await writeInboxAsync(fileSystem, inboxPendingRel, {
    id: randomUUID(),
    type: 'user_inbox_message',
    from: 'user',
    to: name,
    content: message,
    priority: options?.priority ?? 'normal',
    timestamp: new Date().toISOString(),
  }, audit);

  console.log(`Message sent to "${name}"`);
}
