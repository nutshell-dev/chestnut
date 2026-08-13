/**
 * @module L2c.Messaging.WakeupStore
 *
 * phase 1386: 定时消息（wakeup）资源原语。
 *
 * 一个安排 = claw 目录下 `wakeups/<id>.json` 文件，schema_version 显式演进。
 * 安排持久化跨重启；到期由 motion cron `wakeup-delivery` job 扫各 claw wakeups/ →
 * 投递到 claw inbox（见 L4/L6 装配）。
 *
 * 设计：
 * - scheduleWakeup: deliverAt 已过 → 语义为「立即投递」，不落 store（返回 record，
 *   caller 立即投递）；deliverAt 未来 → 原子写文件。
 * - cancelWakeup: 文件不存在 → typed WakeupNotFoundError + audit（不静默）。
 * - consumeDueWakeups: 读到期项（不删文件；投递成功后由 caller 调 removeWakeup 删除；
 *   失败保留，下 tick 重试）。
 * - 写协议：writeAtomicSync（既有原子写惯例）。
 */

import * as path from 'path';
import type { FileSystem } from '../fs/index.js';
import { isFileNotFound } from '../fs/index.js';
import type { AuditLog } from '../audit/index.js';
import { newUuid } from '../node-utils/index.js';
import { MESSAGING_AUDIT_EVENTS } from './audit-events.js';
import { WAKEUPS_DIR } from './dirs.js';

export const WAKEUP_SCHEMA_VERSION = 1 as const;

export interface WakeupRecord {
  readonly schema_version: typeof WAKEUP_SCHEMA_VERSION;
  /** uuid、唯一，同时作为文件名 `<id>.json`。 */
  readonly id: string;
  /** ISO 8601 到期时刻。 */
  readonly deliverAt: string;
  /** 唤醒消息正文（agent 读到知道为什么被叫醒）。 */
  readonly message: string;
  /** ISO 8601 创建时刻。 */
  readonly createdAt: string;
}

/** 安排时 deliverAt 已过：返回的 record 标记 immediate，caller 立即投递、不落 store。 */
export interface ScheduleWakeupResult {
  readonly record: WakeupRecord;
  /** true = deliverAt 已过、未写 store，caller 应立即投递。 */
  readonly immediate: boolean;
}

export class WakeupNotFoundError extends Error {
  readonly code = 'WAKEUP_NOT_FOUND' as const;
  constructor(public readonly wakeupId: string) {
    super(`Wakeup not found: ${wakeupId}`);
    this.name = 'WakeupNotFoundError';
  }
}

export class WakeupDecodeError extends Error {
  readonly code = 'WAKEUP_DECODE_ERROR' as const;
  constructor(public readonly file: string, public readonly reason: string) {
    super(`Failed to decode wakeup file ${file}: ${reason}`);
    this.name = 'WakeupDecodeError';
  }
}

function wakeupsDir(clawDir: string): string {
  return path.join(clawDir, WAKEUPS_DIR);
}

function wakeupFile(clawDir: string, id: string): string {
  return path.join(wakeupsDir(clawDir), `${id}.json`);
}

/**
 * 安排一个定时消息。
 *
 * - deliverAt 已过 → 不落 store，返回 `{ record, immediate: true }`（caller 立即投递）。
 * - deliverAt 未来 → 原子写 `<clawDir>/wakeups/<id>.json`，返回 `{ record, immediate: false }`。
 *
 * audit: wakeup_scheduled（clawId / id / deliverAt）。
 */
export function scheduleWakeup(
  fs: FileSystem,
  clawDir: string,
  clawId: string,
  deliverAt: string,
  message: string,
  audit: AuditLog,
  now: Date = new Date(),
): ScheduleWakeupResult {
  const deliverAtMs = Date.parse(deliverAt);
  if (Number.isNaN(deliverAtMs)) {
    throw new Error(`scheduleWakeup: invalid deliverAt ISO string: ${deliverAt}`);
  }
  const record: WakeupRecord = {
    schema_version: WAKEUP_SCHEMA_VERSION,
    id: newUuid(),
    deliverAt: new Date(deliverAtMs).toISOString(),
    message,
    createdAt: now.toISOString(),
  };

  if (deliverAtMs <= now.getTime()) {
    audit.write(
      MESSAGING_AUDIT_EVENTS.WAKEUP_SCHEDULED,
      `clawId=${clawId}`,
      `id=${record.id}`,
      `deliverAt=${record.deliverAt}`,
      'mode=immediate',
    );
    return { record, immediate: true };
  }

  fs.ensureDirSync(wakeupsDir(clawDir));
  fs.writeAtomicSync(wakeupFile(clawDir, record.id), JSON.stringify(record, null, 2) + '\n');
  audit.write(
    MESSAGING_AUDIT_EVENTS.WAKEUP_SCHEDULED,
    `clawId=${clawId}`,
    `id=${record.id}`,
    `deliverAt=${record.deliverAt}`,
    'mode=persisted',
  );
  return { record, immediate: false };
}

/**
 * 取消一个安排：删除 `<clawDir>/wakeups/<id>.json`。
 * 不存在 → WakeupNotFoundError + audit wakeup_cancelled（status=not_found）。
 */
export function cancelWakeup(
  fs: FileSystem,
  clawDir: string,
  clawId: string,
  wakeupId: string,
  audit: AuditLog,
): WakeupRecord {
  const file = wakeupFile(clawDir, wakeupId);
  let record: WakeupRecord;
  try {
    record = decodeWakeup(fs.readSync(file), file);
  } catch (e) {
    if (isFileNotFound(e)) {
      audit.write(
        MESSAGING_AUDIT_EVENTS.WAKEUP_CANCELLED,
        `clawId=${clawId}`,
        `id=${wakeupId}`,
        'status=not_found',
      );
      throw new WakeupNotFoundError(wakeupId);
    }
    throw e;
  }
  fs.deleteSync(file);
  audit.write(
    MESSAGING_AUDIT_EVENTS.WAKEUP_CANCELLED,
    `clawId=${clawId}`,
    `id=${wakeupId}`,
    'status=cancelled',
  );
  return record;
}

/** 列出一个 claw 的全部安排（按 deliverAt 升序）。目录不存在 → 空数组。 */
export function listWakeups(fs: FileSystem, clawDir: string): WakeupRecord[] {
  let entries: { name: string }[];
  try {
    entries = fs.listSync(wakeupsDir(clawDir), { includeDirs: false });
  } catch (e) {
    if (isFileNotFound(e)) return [];
    throw e;
  }
  const records: WakeupRecord[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith('.json')) continue;
    const file = path.join(wakeupsDir(clawDir), entry.name);
    records.push(decodeWakeup(fs.readSync(file), file));
  }
  records.sort((a, b) => a.deliverAt.localeCompare(b.deliverAt));
  return records;
}

/**
 * 投递 job 用：读到期项（deliverAt <= now）。不删文件——投递成功后 caller 调
 * removeWakeup 删除；失败保留，下 tick 重试。
 */
export function consumeDueWakeups(
  fs: FileSystem,
  clawDir: string,
  now: Date,
): WakeupRecord[] {
  return listWakeups(fs, clawDir).filter((r) => Date.parse(r.deliverAt) <= now.getTime());
}

/** 投递成功后删除安排文件。文件已不存在视为幂等 no-op。 */
export function removeWakeup(fs: FileSystem, clawDir: string, wakeupId: string): void {
  const file = wakeupFile(clawDir, wakeupId);
  try {
    fs.deleteSync(file);
  } catch (e) {
    if (isFileNotFound(e)) return;
    throw e;
  }
}

function decodeWakeup(content: string, file: string): WakeupRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    throw new WakeupDecodeError(file, `invalid JSON: ${(e as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new WakeupDecodeError(file, 'not an object');
  }
  const r = parsed as Record<string, unknown>;
  if (r.schema_version !== WAKEUP_SCHEMA_VERSION) {
    throw new WakeupDecodeError(file, `unsupported schema_version: ${String(r.schema_version)}`);
  }
  if (typeof r.id !== 'string' || typeof r.deliverAt !== 'string'
    || typeof r.message !== 'string' || typeof r.createdAt !== 'string') {
    throw new WakeupDecodeError(file, 'missing or invalid required fields');
  }
  if (Number.isNaN(Date.parse(r.deliverAt))) {
    throw new WakeupDecodeError(file, `invalid deliverAt: ${r.deliverAt}`);
  }
  return {
    schema_version: WAKEUP_SCHEMA_VERSION,
    id: r.id,
    deliverAt: r.deliverAt,
    message: r.message,
    createdAt: r.createdAt,
  };
}
