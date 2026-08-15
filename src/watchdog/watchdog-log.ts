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
import { encodeClawInactivityGuidance, type EncodeClawInactivityGuidanceInput } from './claw-inactivity-guidance.js';

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
// phase 1426: 改 type-specific 函数 / 删 helper 内部 `watchdog_${type}` 模板字符串前缀拼接
// (业主 type 命名由 caller decide / M#2 / phase 1419 formatter 注册 `claw_inactivity` 匹配)
// phase 1258 Step A: generic content record + Object.entries 自动提取退役 —
// writer 收窄为明确的 body + typed guidance facts，extraFields 只经 owner codec
// (claw-inactivity-guidance.ts) 产出（v1 wire / M#7/M#8：未声明字段不再静默落盘）。
export interface WriteClawInactivityInboxParams {
  /** 已格式化的人类可读 body（caller own 字面）。 */
  readonly body: string;
  /** owner codec typed input（camelCase facts / 不声明 wire key）。 */
  readonly guidance: EncodeClawInactivityGuidanceInput;
}

export function writeClawInactivityInbox(
  fsFactory: (baseDir: string) => FileSystem,
  params: WriteClawInactivityInboxParams,
): void {
  const motionDir = getNamedSubrootDir('motion');
  // Motion-only callsite: motionDir = <chestnutRoot>/motion → dirname 一层即 chestnutRoot
  const chestnutRoot = makeChestnutRoot(path.dirname(motionDir));
  const { fs, audit } = getMotionContext(fsFactory);

  routeNotifyClaw(fs, chestnutRoot, MOTION_CLAW_ID, MOTION_CLAW_ID, {
    type: 'claw_inactivity',
    source: 'watchdog',
    priority: 'normal',
    body: params.body,
    idPrefix: `${Date.now()}_claw_inactivity`,
    extraFields: encodeClawInactivityGuidance(params.guidance),
  }, audit);
}

// phase 2 γ4: claw_crashed 不立 helper（与 phase 1482 writeClawInactivityInbox 对称形态偏离）。
// 理由：现 maybeCronClawCrash 内 inline notifyClaw 调用、tests 既有 spy 假设直调路径 / helper 间接增加 vi.mock 解析复杂度。
// 若 future 多 caller 需写 claw_crashed、再 extract helper。
