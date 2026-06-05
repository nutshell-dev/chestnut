import * as path from 'path';
import { formatErr } from "../../../foundation/utils/index.js";
import { isFileNotFound, type FileSystem } from '../../../foundation/fs/types.js';
import type { AuditLog } from '../../../foundation/audit/index.js';
import type { InboxMessageOptionsBase } from '../../../foundation/messaging/index.js';
import { scanArchivedContracts } from './event-collector.js';
import { CONTRACT_AUDIT_EVENTS } from '../audit-events.js';
import { CLAWS_DIR } from '../../../foundation/paths.js';
import { MOTION_CLAW_ID } from '../../../constants.js';
import { makeClawId } from '../../../foundation/identity/index.js'
import { type ChestnutRoot } from '../../../foundation/identity/index.js';
import { makeClawDir } from '../../../foundation/identity/index.js';
import type { CronJob } from '../../cron/runner.js';
import { parseSchedule } from '../../cron/runner.js';
import type { ClawGlobalConfig } from '../../../foundation/config/index.js';


/**
 * Cron job timeout (ms) / 防 stuck handler 占 cron tick.
 * 由本 module 业务自决 (per ML#2 模块为自己业务语义负责).
 */
export const CONTRACT_OBSERVER_CRON_TIMEOUT_MS = 5 * 60_000;

export interface ContractObserverOptions {
  chestnutRoot: ChestnutRoot;       // .chestnut/ 目录
  fs: FileSystem;             // baseDir = chestnutRoot (装配方预 build)
  motionAudit: AuditLog;      // motion system audit (装配方预 build)
  notifyClaw: (fs: FileSystem, chestnutRoot: ChestnutRoot, targetClawId: string, payload: InboxMessageOptionsBase, audit: AuditLog) => void; // 装配方 closure 包装
  signal?: AbortSignal;
}

export interface ContractObserverJobDeps {
  chestnutRoot: ChestnutRoot;
  fs: FileSystem;
  motionAudit: AuditLog;
  notifyClaw: (fs: FileSystem, chestnutRoot: ChestnutRoot, targetClawId: string, payload: InboxMessageOptionsBase, audit: AuditLog) => void;
}

// 持久化文件：observer 状态（已通知 contract set + lastCheckTs metric + bootstrap marker）
const STATE_FILE = 'status/contract-observer-state.json';
const STATE_SCHEMA_VERSION = 2;
const NOTIFIED_CAP = 5000;

/**
 * phase 37: state schema v2 治 observer race。
 * - notifiedContracts: 已 emit 给 motion 的 `<clawId>:<contractId>` 集合。dedup 主防御。
 * - bootstrapDone: false = 首 tick 后填 set 不 emit（防 v1→v2 migration 时大量历史 archive 反复触发 emit）。
 * - lastCheckTs: 仅 metric / debug 用、不再作 hard filter（dedup-based 替代）。
 */
interface ObserverStateV2 {
  version: 2;
  lastCheckTs: number;
  notifiedContracts: string[];
  bootstrapDone: boolean;
}

function loadObserverState(fs: FileSystem, stateFile: string, audit: AuditLog): ObserverStateV2 {
  try {
    const raw = fs.readSync(stateFile);
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) {
      const obj = parsed as Record<string, unknown>;
      // v2 schema
      if (obj.version === STATE_SCHEMA_VERSION &&
          typeof obj.lastCheckTs === 'number' &&
          Array.isArray(obj.notifiedContracts) &&
          obj.notifiedContracts.every(x => typeof x === 'string') &&
          typeof obj.bootstrapDone === 'boolean') {
        return {
          version: STATE_SCHEMA_VERSION,
          lastCheckTs: obj.lastCheckTs,
          notifiedContracts: obj.notifiedContracts as string[],
          bootstrapDone: obj.bootstrapDone,
        };
      }
      // v1 → v2 migration: 用旧 lastCheckTs、空 set、未 bootstrap（首 tick 仅填 set 不 emit）
      if (typeof obj.lastCheckTs === 'number') {
        return {
          version: STATE_SCHEMA_VERSION,
          lastCheckTs: obj.lastCheckTs,
          notifiedContracts: [],
          bootstrapDone: false,
        };
      }
      audit?.write(CONTRACT_AUDIT_EVENTS.OBSERVER_STATE_PARSE_FAILED,
        `reason=shape_mismatch`, `stateFile=${stateFile}`);
    }
  } catch (err) {
    if (!isFileNotFound(err)) {
      const code = (err as NodeJS.ErrnoException)?.code;
      audit?.write(
        CONTRACT_AUDIT_EVENTS.OBSERVER_STATE_LOAD_FAILED,
        `file=${stateFile}`,
        `code=${code ?? 'unknown'}`,
        `error=${formatErr(err)}`,
      );
    }
    // first-run / file 不存在：bootstrap path、首 tick 不 emit
  }
  return {
    version: STATE_SCHEMA_VERSION,
    lastCheckTs: 0,
    notifiedContracts: [],
    bootstrapDone: false,
  };
}

export async function runContractObserver(options: ContractObserverOptions): Promise<void> {
  const { chestnutRoot, fs, motionAudit, notifyClaw: notifyClawFn } = options;

  // phase 37: tickStart 在 scan 开始捕获、写为 lastCheckTs（不再 end-of-scan now、关 race window）
  const tickStart = Date.now();

  const stateFile = path.join(chestnutRoot, 'motion', STATE_FILE);
  const state = loadObserverState(fs, stateFile, motionAudit);
  const notifiedSet = new Set(state.notifiedContracts);
  const wasBootstrapPending = !state.bootstrapDone;

  // 扫描 claws/ 目录
  const clawsDir = path.join(chestnutRoot, CLAWS_DIR);
  let clawIds: string[];
  try {
    clawIds = fs.listSync(clawsDir, { includeDirs: true })
      .filter(e => e.isDirectory)
      .map(e => e.name);
  } catch (err) {
    if (isFileNotFound(err)) return;
    motionAudit.write(
      CONTRACT_AUDIT_EVENTS.CONTRACT_DIR_SCAN_FAILED,
      `dir=${clawsDir}`,
      `reason=${formatErr(err)}`,
    );
    return;
  }

  const completedEvents: string[] = [];
  const cancelledEvents: string[] = [];
  const crashedEvents: string[] = [];
  const recoveryEvents: string[] = [];
  const allProblemPairs: string[] = [];
  const newlyDiscovered: string[] = [];

  for (const clawId of clawIds) {
    if (options.signal?.aborted) return;
    try {
      const clawDir = makeClawDir(path.join(chestnutRoot, CLAWS_DIR, clawId));
      const entries = scanArchivedContracts(fs, clawDir, makeClawId(clawId), motionAudit);
      for (const entry of entries) {
        const key = `${clawId}:${entry.contractId}`;
        if (notifiedSet.has(key)) continue;  // dedup: 已通知
        newlyDiscovered.push(key);
        // bootstrap 期不 emit、仅填 set（防 migration 后历史 archive 大量重 emit）
        if (state.bootstrapDone) {
          switch (entry.status) {
            case 'completed':
              completedEvents.push(entry.body);
              if (entry.hasFailure) allProblemPairs.push(key);
              break;
            case 'cancelled':
              cancelledEvents.push(entry.body);
              break;
            case 'crashed':
              crashedEvents.push(entry.body);
              break;
            case 'archive_pending_recovery':
              recoveryEvents.push(entry.body);
              break;
            default:
              // unknown_status: 投 generic 防丢失（保 contract_events 路径）
              completedEvents.push(entry.body);
          }
        }
      }
    } catch (e) {
      motionAudit.write(
        CONTRACT_AUDIT_EVENTS.OBSERVER_EVENT_FAILED,
        `claw=${clawId}`,
        `reason=${formatErr(e)}`
      );
    }
  }

  // 分流投递 3 个独立 notifyClawFn 调用（type 不同）
  if (completedEvents.length > 0) {
    notifyClawFn(fs, chestnutRoot, MOTION_CLAW_ID, {
      type: 'contract_events',
      source: 'system',
      priority: 'high',
      body: completedEvents.join('\n\n'),
      extraFields: {
        problem_pairs: allProblemPairs.join(','),
      },
    }, motionAudit);
  }

  if (cancelledEvents.length > 0) {
    notifyClawFn(fs, chestnutRoot, MOTION_CLAW_ID, {
      type: 'contract_cancelled',
      source: 'system',
      priority: 'high',
      body: cancelledEvents.join('\n\n'),
    }, motionAudit);
  }

  if (crashedEvents.length > 0) {
    notifyClawFn(fs, chestnutRoot, MOTION_CLAW_ID, {
      type: 'contract_crashed',
      source: 'system',
      priority: 'high',
      body: crashedEvents.join('\n\n'),
    }, motionAudit);
  }

  if (recoveryEvents.length > 0) {
    notifyClawFn(fs, chestnutRoot, MOTION_CLAW_ID, {
      type: 'contract_events',  // recovery 复用 contract_events、不立第 4 个 type
      source: 'system',
      priority: 'high',
      body: recoveryEvents.join('\n\n'),
    }, motionAudit);
  }

  // 更新 state：加入新发现 contract、FIFO cap
  for (const key of newlyDiscovered) notifiedSet.add(key);
  let notifiedArr = Array.from(notifiedSet);
  if (notifiedArr.length > NOTIFIED_CAP) {
    notifiedArr = notifiedArr.slice(notifiedArr.length - NOTIFIED_CAP);
  }
  const newState: ObserverStateV2 = {
    version: STATE_SCHEMA_VERSION,
    lastCheckTs: tickStart,  // phase 37: tickStart 不是 end-of-scan now
    notifiedContracts: notifiedArr,
    bootstrapDone: true,     // 首 tick 后总是 true
  };
  fs.ensureDirSync(path.dirname(stateFile));
  fs.writeAtomicSync(stateFile, JSON.stringify(newState));

  // bootstrap 完成的 trace
  if (wasBootstrapPending) {
    motionAudit.write(
      CONTRACT_AUDIT_EVENTS.OBSERVER_BOOTSTRAP_DONE,
      `notified_count=${notifiedArr.length}`,
    );
  }
}

export function createContractObserverJob(
  deps: ContractObserverJobDeps,
  globalConfig: ClawGlobalConfig,
): CronJob {
  return {
    name: 'contract-observer',
    enabled: globalConfig.cron.jobs.contract_observer.enabled,
    schedule: parseSchedule(globalConfig.cron.jobs.contract_observer.schedule, deps.motionAudit),
    handler: (signal) => runContractObserver({ ...deps, signal }),
    timeoutMs: CONTRACT_OBSERVER_CRON_TIMEOUT_MS,
  };
}
