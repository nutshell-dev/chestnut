/**
 * @module L6.Watchdog.Log
 * Watchdog logging + audit + inbox message
 */

import * as path from 'path';
import type { FileSystem } from '../foundation/fs/types.js';
import { getClawforumFs, getAuditWriter, getMotionContext } from './watchdog-context.js';
import { getNamedSubrootDir } from '../foundation/config/index.js';
import { notifyClaw } from '../foundation/messaging/index.js';
import { WATCHDOG_LOG } from './constants.js';
import { MOTION_CLAW_ID } from '../constants.js';

/** 1:1 保 watchdog.ts:152-164 */
export function log(fsFactory: (baseDir: string) => FileSystem, message: string): void {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] ${message}\n`;
  console.log(logLine.trim());

  try {
    const fs = getClawforumFs(fsFactory);
    fs.ensureDirSync(path.dirname(WATCHDOG_LOG));
    fs.appendSync(WATCHDOG_LOG, logLine);
  } catch {
    // silent: fallback already logged to stdout
  }
}

/** 1:1 保 watchdog.ts:166-176 */
export function logWithAudit(
  fsFactory: (baseDir: string) => FileSystem,
  message: string,
  auditType?: string,
  payload?: string,
): void {
  log(fsFactory, message);
  const auditWriter = getAuditWriter();
  if (auditType && auditWriter) {
    auditWriter.write(auditType, payload ?? message);
  }
}

// Write an inbox message (YAML frontmatter .md format)
/** 1:1 保 watchdog.ts:178-191 */
export function writeWatchdogInboxMessage(fsFactory: (baseDir: string) => FileSystem, type: string, content: Record<string, unknown>): void {
  const motionDir = getNamedSubrootDir('motion');
  const clawforumRoot = path.dirname(motionDir);
  const { fs, audit } = getMotionContext(fsFactory);
  const body = typeof content.message === 'string' ? content.message : JSON.stringify(content);
  notifyClaw(fs, clawforumRoot, MOTION_CLAW_ID, {
    type: `watchdog_${type}`,
    source: 'watchdog',
    priority: 'high',
    body,
    idPrefix: `${Date.now()}_${type}`,
  }, audit);
}
