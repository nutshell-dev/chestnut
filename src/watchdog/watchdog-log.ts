/**
 * @module L6.Watchdog.Log
 * Watchdog logging + audit
 *
 * phase 1383 (P2b): writeClawInactivityInbox 退场（停滞自活归 daemon 内化）。
 */

import * as path from 'path';
import type { FileSystem } from '../foundation/fs/index.js';
import { getChestnutFs, getAuditWriter } from './watchdog-context.js';
import { WATCHDOG_LOG } from './constants.js';

/** 1:1 保 watchdog.ts:152-164 */
export function log(fsFactory: (baseDir: string) => FileSystem, message: string): void {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] ${message}\n`;
  console.log(logLine.trim());

  try {
    const fs = getChestnutFs(fsFactory);
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
