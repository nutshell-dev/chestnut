/**
 * @module L6.Daemon.HeartbeatFact
 * @layer L6 进程边界（Daemon 事件循环）
 *
 * Phase 1878 Step B（watchdog-heartbeat-supervision-absent）：Daemon 稳定心跳协议面。
 *
 * 背景：此前 daemon liveness 仅写 audit tick 文件，没有独立心跳事实供 Watchdog
 * 判「alive but heartbeat stale」（进程仍在但事件循环完全阻塞）。本模块立协议：
 * - 写出面（Daemon own）：liveness tick 时把心跳事实（单调时间戳）落盘到
 *   daemon-owned namespace（`<agentDir>/daemon/heartbeat.json`，对齐 1873 G
 *   DAEMON_STATE_DIR 惯例）；写失败由 caller 审计、不阻断 daemon。
 * - 消费面（Supervisor/Viewport 单向读取）：readDaemonHeartbeat typed result
 *   （ok / missing / legacy / corrupt），身份与 freshness 判定归消费方。
 */
import * as path from 'path';
import type { FileSystem } from '../foundation/fs/index.js';
import { isFileNotFound } from '../foundation/fs/index.js';
import { formatErr } from '../foundation/node-utils/index.js';
import { DAEMON_STATE_DIR } from './constants.js';

/** 心跳事实文件（agentDir 相对；daemon-owned namespace）。 */
export const DAEMON_HEARTBEAT_FILE = path.posix.join(DAEMON_STATE_DIR, 'heartbeat.json');

/** Daemon 写出的心跳事实（协议 schema v2，绑定当前 activation identity）。 */
export interface DaemonHeartbeatFact {
  schema_version: 2;
  /** 本次 liveness tick 的墙钟时间（ms epoch；正常进程内随 tick 单调递增）。 */
  ts: number;
  pid: number;
  generation_id: string;
  start_time: string;
}

export type DaemonHeartbeatRead =
  | { kind: 'ok'; fact: DaemonHeartbeatFact }
  /** 文件缺失（旧版本 daemon / 未写）——升级窗口的显式 unknown 语义。 */
  | { kind: 'missing' }
  /** schema v1 只能作为 legacy unknown，不得冒充当前进程心跳。 */
  | { kind: 'legacy'; error: string }
  /** 文件存在但不可解析（JSON/schema 失败）。 */
  | { kind: 'corrupt'; error: string };

/**
 * 写心跳事实。liveness tick 节拍调用；写失败 throw（caller 审计、不阻断）。
 * writeAtomicSync 自建父目录（daemon/ namespace 惰性建立）。
 */
export function writeDaemonHeartbeat(
  fs: FileSystem,
  now: number,
  identity: { generationId: string; startTime: string } | undefined,
): void {
  if (
    !identity?.generationId
    || identity.generationId.trim().length === 0
    || !identity.startTime
    || identity.startTime.trim().length === 0
  ) {
    throw new Error('daemon heartbeat identity unavailable');
  }
  const fact: DaemonHeartbeatFact = {
    schema_version: 2,
    ts: now,
    pid: process.pid,
    generation_id: identity.generationId,
    start_time: identity.startTime,
  };
  fs.writeAtomicSync(DAEMON_HEARTBEAT_FILE, JSON.stringify(fact));
}

/** 读心跳事实（单向消费面）；读取 IO 错误按 corrupt 显式返回，不抛。 */
export function readDaemonHeartbeat(fs: FileSystem): DaemonHeartbeatRead {
  let raw: string;
  try {
    raw = fs.readSync(DAEMON_HEARTBEAT_FILE);
  } catch (err) {
    if (isFileNotFound(err)) return { kind: 'missing' };
    return { kind: 'corrupt', error: formatErr(err) };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { kind: 'corrupt', error: 'schema mismatch' };
    }
    const candidate = parsed as Record<string, unknown>;
    if (candidate.schema_version === 1) {
      return { kind: 'legacy', error: 'legacy schema_version=1' };
    }
    if (candidate.schema_version !== 2) {
      return { kind: 'corrupt', error: 'schema mismatch' };
    }
    if (typeof candidate.ts !== 'number' || !Number.isFinite(candidate.ts)) {
      return { kind: 'corrupt', error: 'invalid heartbeat ts' };
    }
    if (typeof candidate.pid !== 'number' || !Number.isSafeInteger(candidate.pid) || candidate.pid <= 0) {
      return { kind: 'corrupt', error: 'invalid heartbeat pid' };
    }
    if (typeof candidate.generation_id !== 'string' || candidate.generation_id.trim().length === 0) {
      return { kind: 'corrupt', error: 'invalid heartbeat generation_id' };
    }
    if (typeof candidate.start_time !== 'string' || candidate.start_time.trim().length === 0) {
      return { kind: 'corrupt', error: 'invalid heartbeat start_time' };
    }
    return { kind: 'ok', fact: candidate as unknown as DaemonHeartbeatFact };
  } catch (err) {
    return { kind: 'corrupt', error: formatErr(err) };
  }
}
