/**
 * @module L6.Watchdog.Log
 * Watchdog logging + audit + inbox message
 */

import * as path from 'path';
import { makeClawforumRoot, makeClawDir } from '../foundation/identity/index.js';
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

// Write the `claw_inactivity` inbox message (YAML frontmatter .md format).
// phase 1426: 改 type-specific 函数 / 删 helper 内部 `watchdog_${type}` 模板字符串前缀拼接
// (业主 type 命名由 caller decide / ML#2 / phase 1419 formatter 注册 `claw_inactivity` 匹配)
// phase 1482: extraFields 通道开放 — `failure_class` + struct context 透传到 InboxWriter
// → encodeInbox YAML frontmatter → 收件方 extraMeta → motion guidance composer 按 class switch.
export function writeClawInactivityInbox(
  fsFactory: (baseDir: string) => FileSystem,
  content: Record<string, unknown>,
): void {
  const motionDir = makeClawDir(getNamedSubrootDir('motion'));
  // Motion-only callsite: motionDir = <clawforumRoot>/motion → dirname 一层即 clawforumRoot
  const clawforumRoot = makeClawforumRoot(path.dirname(motionDir));
  const { fs, audit } = getMotionContext(fsFactory);
  const body = typeof content.message === 'string' ? content.message : JSON.stringify(content);

  // phase 1482: 提取所有 string-coercible 字段（除 message 本身）作为 extraFields → motion guidance state
  const extraFields: Record<string, string> = {};
  for (const [k, v] of Object.entries(content)) {
    if (k === 'message') continue;
    if (v === undefined || v === null) continue;
    extraFields[k] = typeof v === 'string' ? v : String(v);
  }

  notifyClaw(fs, clawforumRoot, MOTION_CLAW_ID, {
    type: 'claw_inactivity',
    source: 'watchdog',
    priority: 'high',
    body,
    idPrefix: `${Date.now()}_claw_inactivity`,
    extraFields,
  }, audit);
}
