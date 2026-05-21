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
import { NodeFileSystem } from '../../foundation/fs/node-fs.js';
import { InboxWriter } from '../../foundation/messaging/index.js';
import { createSystemAudit } from '../../foundation/audit/index.js';
import { CLAWS_DIR } from '../../foundation/paths.js';

export async function sendCommand(
  name: string, 
  message: string, 
  options?: { priority?: 'critical' | 'high' | 'normal' | 'low' }
): Promise<void> {
  loadGlobalConfig(CONFIG_DEFAULTS);
  
  if (!clawExists(name)) {
    throw new CliError(`Claw "${name}" does not exist`);
  }

  const globalConfigPath = getGlobalConfigPath();
  const baseDir = path.dirname(globalConfigPath);
  const clawDir = path.join(baseDir, CLAWS_DIR, name);
  const fs = new NodeFileSystem({ baseDir: clawDir });
  const audit = createSystemAudit(fs, clawDir);
  const inboxPendingRel = path.join('inbox', 'pending');

  await new InboxWriter(fs, inboxPendingRel, audit).write({
    id: randomUUID(),
    type: 'user_inbox_message',
    from: 'user',
    to: name,
    content: message,
    priority: options?.priority ?? 'normal',
    timestamp: new Date().toISOString(),
  });

  console.log(`Message sent to "${name}"`);
}
