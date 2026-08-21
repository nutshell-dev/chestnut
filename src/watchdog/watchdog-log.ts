/**
 * @module L6.Watchdog.Log
 * Watchdog logging + audit helpers.
 *
 * Phase 1396 Step H: motion-facing inbox writers retired; this module keeps
 * console/append-only log and best-effort audit forwarding only.
 *
 * Phase 1455 Step B: log 写路径归位 WATCHDOG_PATHS.log（watchdog/watchdog.log）。
 */

import * as path from 'path';
import type { FileSystem } from '../foundation/fs/index.js';
import { getChestnutFs, getAuditWriter } from './watchdog-context.js';
import { WATCHDOG_PATHS } from './layout.js';

/** 1:1 保 watchdog.ts:152-164 */
export function log(fsFactory: (baseDir: string) => FileSystem, message: string): void {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] ${message}\n`;
  console.log(logLine.trim());

  try {
    const fs = getChestnutFs(fsFactory);
    // Phase 1455 Step B: 写路径归位 watchdog/watchdog.log（constants.ts 旧 log
    // 常量退役、WATCHDOG_PATHS.log 单源）；legacy logs/watchdog.log 保留为历史、
    // 清退归 Step C。
    fs.ensureDirSync(path.dirname(WATCHDOG_PATHS.log));
    fs.appendSync(WATCHDOG_PATHS.log, logLine);
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
