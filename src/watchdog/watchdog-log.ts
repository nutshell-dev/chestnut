/**
 * @module L6.Watchdog.Log
 * Watchdog logging + audit + inbox message
 */

import { makeChestnutRoot } from '../core/claw-topology/index.js';
import * as path from 'path';
import type { FileSystem } from '../foundation/fs/index.js';
import { getChestnutFs, getAuditWriter, getMotionContext } from './watchdog-context.js';
import { getNamedSubrootDir } from '../core/claw-topology/index.js';
import { routeNotifyClaw } from '../core/claw-topology/index.js';
import { WATCHDOG_LOG } from './constants.js';
import { MOTION_CLAW_ID } from '../core/claw-topology/index.js';

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

// Write the `claw_inactivity` inbox message (YAML frontmatter .md format).
// phase 1426: type-specific 函数 / 删 helper 内部 `watchdog_${type}` 模板字符串前缀拼接
// Phase 1396 Step F: guidance codec 退役；新消息只保留 body，不再写 extraFields。
// 旧 inbox 中的历史 `claw_inactivity` 消息由 Runtime 通用 fallback 读取，不阻塞 drain。
export function writeClawInactivityInbox(
  fsFactory: (baseDir: string) => FileSystem,
  body: string,
): void {
  const motionDir = getNamedSubrootDir('motion');
  // Motion-only callsite: motionDir = <chestnutRoot>/motion → dirname 一层即 chestnutRoot
  const chestnutRoot = makeChestnutRoot(path.dirname(motionDir));
  const { fs, audit } = getMotionContext(fsFactory);

  routeNotifyClaw(fs, chestnutRoot, MOTION_CLAW_ID, MOTION_CLAW_ID, {
    type: 'claw_inactivity',
    source: 'watchdog',
    priority: 'normal',
    body,
    idPrefix: `${Date.now()}_claw_inactivity`,
  }, audit);
}

// phase 2 γ4: claw_crashed 不立 helper（与 phase 1482 writeClawInactivityInbox 对称形态偏离）。
// 理由：现 maybeCronClawCrash 内 inline notifyClaw 调用、tests 既有 spy 假设直调路径 / helper 间接增加 vi.mock 解析复杂度。
// 若 future 多 caller 需写 claw_crashed、再 extract helper。
