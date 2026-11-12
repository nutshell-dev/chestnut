/**
 * @module L6.Daemon.TurnState
 * @layer L6 进程边界（Daemon 持久事实）
 *
 * Phase 2135 Step B：daemon-owned turn 状态事实。EventLoop 只消费 core 声明的
 * sink；本模块拥有文件协议、revision 推进与原子写实现，viewport 只读恢复。
 */
import * as path from 'path';
import type { EventLoopTurnStateSink } from '../core/event-loop/index.js';
import type { FileSystem } from '../foundation/fs/index.js';
import { isFileNotFound } from '../foundation/fs/index.js';
import { formatErr } from '../foundation/node-utils/index.js';
import { DAEMON_STATE_DIR } from './constants.js';

/** Turn 状态事实文件（agentDir 相对；daemon-owned namespace）。 */
export const DAEMON_TURN_STATE_FILE = path.posix.join(DAEMON_STATE_DIR, 'turn-state.json');

interface DaemonTurnStateBase {
  schema_version: 1;
  revision: number;
  updatedAtMs: number;
  clawId: string;
  daemonPid: number;
}

export type DaemonTurnState =
  | (DaemonTurnStateBase & { phase: 'idle' })
  | (DaemonTurnStateBase & { phase: 'active'; startedAtMs: number; traceId?: string });

export type DaemonTurnStateRead =
  | { kind: 'ok'; fact: DaemonTurnState }
  | { kind: 'missing' }
  | { kind: 'corrupt'; error: string };

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** 严格校验 v1：字段集合、类型和 idle/active 的 startedAtMs 判别约束均须匹配。 */
function decodeDaemonTurnState(raw: string): DaemonTurnState | undefined {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const commonKeys = ['schema_version', 'phase', 'revision', 'updatedAtMs', 'clawId', 'daemonPid'];
  const expectedKeys = record.phase === 'active'
    ? [...commonKeys, 'startedAtMs', ...('traceId' in record ? ['traceId'] : [])]
    : commonKeys;
  const actualKeys = Object.keys(record).sort();
  if (actualKeys.join(',') !== expectedKeys.sort().join(',')) return undefined;
  if (
    record.schema_version !== 1
    || (record.phase !== 'idle' && record.phase !== 'active')
    || !Number.isSafeInteger(record.revision)
    || (record.revision as number) <= 0
    || !isNonNegativeFiniteNumber(record.updatedAtMs)
    || typeof record.clawId !== 'string'
    || record.clawId.length === 0
    || !Number.isSafeInteger(record.daemonPid)
    || (record.daemonPid as number) <= 0
  ) {
    return undefined;
  }
  if (record.phase === 'active' && !isNonNegativeFiniteNumber(record.startedAtMs)) return undefined;
  if ('traceId' in record && (record.phase !== 'active' || typeof record.traceId !== 'string')) return undefined;
  return record as unknown as DaemonTurnState;
}

/** 读取失败不抛：缺失与 JSON/schema/IO 损坏均为显式 typed result。 */
export function readDaemonTurnState(fs: FileSystem): DaemonTurnStateRead {
  let raw: string;
  try {
    raw = fs.readSync(DAEMON_TURN_STATE_FILE);
  } catch (error) {
    if (isFileNotFound(error)) return { kind: 'missing' };
    return { kind: 'corrupt', error: formatErr(error) };
  }
  try {
    const fact = decodeDaemonTurnState(raw);
    return fact ? { kind: 'ok', fact } : { kind: 'corrupt', error: 'schema mismatch' };
  } catch (error) {
    return { kind: 'corrupt', error: formatErr(error) };
  }
}

export interface DaemonTurnStateStoreOptions {
  fs: FileSystem;
  clawId: string;
  daemonPid: number;
  now?: () => number;
}

export interface DaemonTurnStateStore extends EventLoopTurnStateSink {
  /** 启动时重读最新 revision 并收束为 idle；返回被替换的事实供损坏证据审计。 */
  reconcileIdle(): DaemonTurnStateRead;
  /** liveness 心跳刷新长 turn 的 updatedAtMs；不改变 revision 或 startedAtMs。 */
  refreshActive(): void;
}

/**
 * 每次 mutation 均重读磁盘最新 revision，再以 writeAtomicSync 整体替换。
 * turnFinish 在磁盘已为 idle 时不写、不推进 revision，因此 terminal callback 与
 * processTurn finally 可重复收束；写异常原样上抛，由调用方隔离并审计。
 */
export function createDaemonTurnStateStore(options: DaemonTurnStateStoreOptions): DaemonTurnStateStore {
  const now = options.now ?? Date.now;

  const write = (phase: 'idle' | 'active', revision: number): void => {
    const updatedAtMs = now();
    const base = {
      schema_version: 1 as const,
      phase,
      revision,
      updatedAtMs,
      clawId: options.clawId,
      daemonPid: options.daemonPid,
    };
    const fact: DaemonTurnState = phase === 'active'
      ? { ...base, phase, startedAtMs: updatedAtMs }
      : { ...base, phase };
    options.fs.writeAtomicSync(DAEMON_TURN_STATE_FILE, JSON.stringify(fact));
  };

  const nextRevision = (read: DaemonTurnStateRead): number => read.kind === 'ok' ? read.fact.revision + 1 : 1;

  const finish = (): void => {
    const latest = readDaemonTurnState(options.fs);
    if (latest.kind === 'ok' && latest.fact.phase === 'idle') return;
    write('idle', nextRevision(latest));
  };

  return {
    reconcileIdle() {
      const latest = readDaemonTurnState(options.fs);
      write('idle', nextRevision(latest));
      return latest;
    },
    refreshActive() {
      const latest = readDaemonTurnState(options.fs);
      if (
        latest.kind !== 'ok'
        || latest.fact.phase !== 'active'
        || latest.fact.clawId !== options.clawId
        || latest.fact.daemonPid !== options.daemonPid
      ) return;
      options.fs.writeAtomicSync(DAEMON_TURN_STATE_FILE, JSON.stringify({
        ...latest.fact,
        updatedAtMs: now(),
      }));
    },
    turnStart() {
      const latest = readDaemonTurnState(options.fs);
      write('active', nextRevision(latest));
    },
    turnEnd: finish,
    turnInterrupted: finish,
    turnError: finish,
    turnFinish: finish,
  };
}
