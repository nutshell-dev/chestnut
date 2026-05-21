/**
 * @module L6.Watchdog.Log
 * Watchdog logging + audit + inbox message
 */

import * as path from 'path';
import { getClawforumDir, getClawforumFs, getAuditWriter, getMotionContext } from './watchdog-context.js';
import { getMotionDir } from '../foundation/config/index.js';
import { InboxWriter } from '../foundation/messaging/index.js';
import { LOGS_DIR } from '../foundation/paths.js';

/** 1:1 保 watchdog.ts:152-164 */
export function log(message: string): void {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] ${message}\n`;
  console.log(logLine.trim());

  try {
    const fs = getClawforumFs();
    fs.ensureDirSync(LOGS_DIR);
    fs.appendSync(path.join(LOGS_DIR, 'watchdog.log'), logLine);
  } catch {
    // Fallback: already output to stdout above
  }
}

/** 1:1 保 watchdog.ts:166-176 */
export function logWithAudit(
  message: string,
  auditType?: string,
  payload?: string,
): void {
  log(message);
  const auditWriter = getAuditWriter();
  if (auditType && auditWriter) {
    auditWriter.write(auditType, payload ?? message);
  }
}

// Write an inbox message (YAML frontmatter .md format)
/** 1:1 保 watchdog.ts:178-191 */
export function writeWatchdogInboxMessage(type: string, content: Record<string, unknown>): void {
  const motionDir = getMotionDir();
  const inboxDir = path.join(motionDir, 'inbox', 'pending');
  const { fs, audit } = getMotionContext();
  const body = typeof content.message === 'string' ? content.message : JSON.stringify(content);
  new InboxWriter(fs, inboxDir, audit).writeSync({
    type: `watchdog_${type}`,
    source: 'watchdog',
    priority: 'high',
    body,
    idPrefix: `${Date.now()}_${type}`,
    filenameTag: `watchdog_${type}`,
  });
}
