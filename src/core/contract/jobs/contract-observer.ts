import * as path from 'path';
import { formatErr, assertNever } from "../../../foundation/utils/index.js";
import { isFileNotFound, type FileSystem } from '../../../foundation/fs/index.js';
import type { AuditLog } from '../../../foundation/audit/index.js';
import type { ClawTopology } from '../../../core/claw-topology/index.js';
import type { InboxMessageOptionsBase } from '../../../foundation/messaging/index.js';
import { scanArchivedContracts } from './event-collector.js';
import { CONTRACT_AUDIT_EVENTS } from '../audit-events.js';
import { emitContractArchiveRecoveryPendingObserved } from '../audit-emit.js';

/** phase 101: DI callback - caller (装配期) bind fs + chestnutRoot + MOTION_CLAW_ID + audit */
export type NotifyMotionFn = (message: InboxMessageOptionsBase) => void;
import type { CronJob } from '../../cron/runner.js';
import { parseSchedule } from '../../cron/runner.js';
import type { CronJobGlobalConfig } from '../../cron/runner.js';
import { makeClawId } from '../../../foundation/identity/index.js';
import { MOTION_CLAW_ID } from '../../claw-topology/index.js';


/**
 * Cron job timeout (ms) / 防 stuck handler 占 cron tick.
 * 由本 module 业务自决 (per M#2 模块为自己业务语义负责).
 */
export const CONTRACT_OBSERVER_CRON_TIMEOUT_MS = 5 * 60_000;

export interface ContractObserverOptions {
  /** phase 259: caller (装配期) 注入的 claw topology */
  clawTopology: ClawTopology;
  /** phase 101: caller (装配期) 算好的 motion dir (state file 位置) */
  motionDir: string;
  fs: FileSystem;
  motionAudit: AuditLog;
  /** phase 101: pre-bound notifyMotion */
  notifyMotion: NotifyMotionFn;
  signal?: AbortSignal;
}

export interface ContractObserverJobDeps {
  clawTopology: ClawTopology;
  motionDir: string;
  fs: FileSystem;
  motionAudit: AuditLog;
  notifyMotion: NotifyMotionFn;
}

// 持久化文件：observer 状态（已通知 contract set + lastCheckTs metric + bootstrap marker）
const STATE_FILE = 'status/contract-observer-state.json';

/**
 * Persisted observer state schema 版本号.
 * Derivation: 1 → 2 在 phase 37 引入 dedup-based 通知去重（替代 lastCheckTs hard filter）;
 * 升级时整 set notifiedContracts 字段 migration / 用版本号区分 read 路径.
 */
const STATE_SCHEMA_VERSION = 2;

/**
 * notifiedContracts set 上限 — 防 long-lived observer 累积 set 膨胀致 state file 超大.
 * Derivation: 5000 ≈ 一年活跃 contract 上限（按 ~14/day 估算）/ 配 LRU evict 老 entry /
 * 触上限 audit emit 提示运维（实际未达上限 ≈ 实际项目跑了几月后才接近）.
 */
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
  const { clawTopology, motionDir, fs, motionAudit, notifyMotion } = options;

  // phase 37: tickStart 在 scan 开始捕获、写为 lastCheckTs（不再 end-of-scan now、关 race window）
  const tickStart = Date.now();

  const stateFile = path.join(motionDir, STATE_FILE);
  const state = loadObserverState(fs, stateFile, motionAudit);
  const notifiedSet = new Set(state.notifiedContracts);
  const wasBootstrapPending = !state.bootstrapDone;

  // 扫描 claws/ 目录
  let clawIds: string[];
  try {
    clawIds = clawTopology.enumerate().filter(id => id !== MOTION_CLAW_ID);
  } catch (err) {
    if (isFileNotFound(err)) return;
    motionAudit.write(
      CONTRACT_AUDIT_EVENTS.CONTRACT_DIR_SCAN_FAILED,
      `reason=${formatErr(err)}`,
    );
    return;
  }

  const completedEvents: string[] = [];
  const cancelledEvents: string[] = [];
  const crashedEvents: string[] = [];
  // recoveryEvents 数组删除（phase 197: 不再投 motion、改 emit audit）
  const allProblemPairs: string[] = [];
  const newlyDiscovered: string[] = [];
  const cancellations: Array<{ source_claw: string; contract_id: string; reason: string }> = [];
  const crashes: Array<{ source_claw: string; contract_id: string; cause: string }> = [];

  for (const clawId of clawIds) {
    if (options.signal?.aborted) return;
    try {
      const location = clawTopology.resolve(makeClawId(clawId));
      if (location.kind !== 'local') continue;
      const entries = scanArchivedContracts(fs, location.clawDir, makeClawId(clawId), motionAudit);
      for (const entry of entries) {
        // phase 324 H11: 验 claw / contract id 字符集，防 `:` `,` `` ` `` `\n` 注入。
        // 不合规 id 跳过、不入 problem_pairs / dedup set；audit 一条 OBSERVER_EVENT_FAILED。
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(clawId) || !/^[A-Za-z0-9_-]{1,64}$/.test(entry.contractId)) {
          motionAudit.write(
            CONTRACT_AUDIT_EVENTS.OBSERVER_EVENT_FAILED,
            `claw=${clawId}`,
            `contract=${entry.contractId}`,
            `reason=id_charset_invalid`,
          );
          continue;
        }
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
              cancellations.push({
                source_claw: clawId,
                contract_id: entry.contractId,
                reason: entry.reason ?? '(no reason given)',
              });
              break;
            case 'crashed':
              crashedEvents.push(entry.body);
              crashes.push({
                source_claw: clawId,
                contract_id: entry.contractId,
                cause: entry.cause ?? '(no cause given)',
              });
              break;
            case 'archive_pending_recovery':
              // phase 197: 系统内部状态、motion 无 actionable、归 audit 不投 inbox
              emitContractArchiveRecoveryPendingObserved(motionAudit, {
                clawId: makeClawId(clawId),
                contractId: entry.contractId,
                context: 'observer_scan',
              });
              break;
            // phase 356: 'pending'/'running'/'paused' unreachable cases 删 (narrow ArchiveAllowedStatus 编译期 enforce 不可达)
            default:
              return assertNever(entry.status);
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

  // 分流投递 4 个独立 notifyMotion 调用（type 不同）
  if (completedEvents.length > 0) {
    notifyMotion({
      type: 'contract_events',
      source: 'system',
      priority: 'high',
      body: completedEvents.join('\n\n'),
      extraFields: {
        problem_pairs: allProblemPairs.join(','),
      },
    });
  }

  if (cancelledEvents.length > 0) {
    notifyMotion({
      type: 'contract_cancelled',
      source: 'system',
      priority: 'high',
      body: cancelledEvents.join('\n\n'),
      extraFields: {
        cancellations: JSON.stringify(cancellations),
      },
    });
  }

  if (crashedEvents.length > 0) {
    notifyMotion({
      type: 'contract_crashed',
      source: 'system',
      priority: 'high',
      body: crashedEvents.join('\n\n'),
      extraFields: {
        crashes: JSON.stringify(crashes),
      },
    });
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
  globalConfig: CronJobGlobalConfig<'contract_observer'>,
): CronJob {
  return {
    name: 'contract-observer',
    enabled: globalConfig.cron.jobs.contract_observer.enabled,
    schedule: parseSchedule(globalConfig.cron.jobs.contract_observer.schedule, deps.motionAudit),
    handler: (signal) => runContractObserver({ ...deps, signal }),
    timeoutMs: CONTRACT_OBSERVER_CRON_TIMEOUT_MS,
  };
}
