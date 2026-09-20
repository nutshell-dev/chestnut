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
 * - 消费面（Watchdog 单向读取）：readDaemonHeartbeat 三分 typed result
 *   （ok / missing / corrupt），判定与动作归 Watchdog。
 */
import * as path from 'path';
import type { FileSystem } from '../foundation/fs/index.js';
import { isFileNotFound } from '../foundation/fs/index.js';
import { formatErr } from '../foundation/node-utils/index.js';
import { DAEMON_STATE_DIR } from './constants.js';

/** 心跳事实文件（agentDir 相对；daemon-owned namespace）。 */
export const DAEMON_HEARTBEAT_FILE = path.posix.join(DAEMON_STATE_DIR, 'heartbeat.json');

/** Daemon 写出的心跳事实（协议 schema v1）。 */
export interface DaemonHeartbeatFact {
  schema_version: 1;
  /** 本次 liveness tick 的墙钟时间（ms epoch；正常进程内随 tick 单调递增）。 */
  ts: number;
  pid: number;
}

export type DaemonHeartbeatRead =
  | { kind: 'ok'; fact: DaemonHeartbeatFact }
  /** 文件缺失（旧版本 daemon / 未写）——升级窗口的显式 unknown 语义。 */
  | { kind: 'missing' }
  /** 文件存在但不可解析（JSON/schema 失败）。 */
  | { kind: 'corrupt'; error: string };

/**
 * 写心跳事实。liveness tick 节拍调用；写失败 throw（caller 审计、不阻断）。
 * writeAtomicSync 自建父目录（daemon/ namespace 惰性建立）。
 */
export function writeDaemonHeartbeat(fs: FileSystem, now: number): void {
  const fact: DaemonHeartbeatFact = { schema_version: 1, ts: now, pid: process.pid };
  fs.writeAtomicSync(DAEMON_HEARTBEAT_FILE, JSON.stringify(fact));
}

/** 读心跳事实（Watchdog 单向消费面）；读取 IO 错误按 corrupt 显式返回，不抛。 */
export function readDaemonHeartbeat(fs: FileSystem): DaemonHeartbeatRead {
  let raw: string;
  try {
    raw = fs.readSync(DAEMON_HEARTBEAT_FILE);
  } catch (err) {
    if (isFileNotFound(err)) return { kind: 'missing' };
    return { kind: 'corrupt', error: formatErr(err) };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<DaemonHeartbeatFact> | null;
    if (
      parsed
      && typeof parsed === 'object'
      && parsed.schema_version === 1
      && typeof parsed.ts === 'number'
      && Number.isFinite(parsed.ts)
      && typeof parsed.pid === 'number'
    ) {
      return { kind: 'ok', fact: parsed as DaemonHeartbeatFact };
    }
    return { kind: 'corrupt', error: 'schema mismatch' };
  } catch (err) {
    return { kind: 'corrupt', error: formatErr(err) };
  }
}
