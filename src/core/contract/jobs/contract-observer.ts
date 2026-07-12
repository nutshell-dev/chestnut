import * as path from 'path';
import { formatErr } from "../../../foundation/node-utils/index.js";
import { isFileNotFound, type FileSystem } from '../../../foundation/fs/index.js';
import type { AuditLog } from '../../../foundation/audit/index.js';
import type { ClawTopology } from '../../../core/claw-topology/index.js';
import type { InboxMessageOptionsBase } from '../../../foundation/messaging/index.js';
import { scanArchivedContracts } from './event-collector.js';
import { CONTRACT_AUDIT_EVENTS } from '../audit-events.js';
import { emitContractArchiveRecoveryPendingObserved } from '../audit-emit.js';

/** phase 101: DI callback - caller (装配期) bind fs + chestnutRoot + MOTION_CLAW_ID + audit */
export type NotifyMotionFn = (message: InboxMessageOptionsBase) => Promise<void>;
import type { CronJob } from '../../../foundation/cron/runner.js';
import { parseSchedule } from '../../../foundation/cron/runner.js';
import type { CronJobGlobalConfig } from '../../../foundation/cron/runner.js';
import { makeClawId } from '../../../foundation/claw-identity/index.js';
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
  /** phase 821: worker claw 契约完成后触发 evolution system 复盘的回调 */
  onCompletedContract?: (clawId: string, contractId: string) => Promise<void>;
  signal?: AbortSignal;
}

export interface ContractObserverJobDeps {
  clawTopology: ClawTopology;
  motionDir: string;
  fs: FileSystem;
  motionAudit: AuditLog;
  notifyMotion: NotifyMotionFn;
  /** phase 821: worker claw 契约完成后触发 evolution system 复盘的回调 */
  onCompletedContract?: (clawId: string, contractId: string) => Promise<void>;
}

// 持久化文件：observer 状态（lastCheckTs metric + lastArchivedAt 水位线 + bootstrap marker）
const STATE_FILE = 'status/contract-observer-state.json';

/**
 * Persisted observer state schema 版本号.
 * Derivation: 1 → 2 在 phase 37 引入 dedup-based 通知去重（替代 lastCheckTs hard filter）;
 * 2 → 3 在 phase 946 改为基于 archive timestamp 的水位线去重、移除有界 set。
 */
const STATE_SCHEMA_VERSION = 3;

/**
 * phase 946: state schema v3 治 observer 循环重发 / 通知丢失 / 状态损坏静默。
 * - lastArchivedAt: 上次成功通知的最大 archive timestamp 水位线（只通知更新的契约）。
 * - bootstrapDone: false = 首 tick 仅更新水位、不 emit（防首次启动历史 archive 大量重 emit）。
 * - lastCheckTs: 仅 metric / debug 用。
 */
interface ObserverStateV3 {
  version: 3;
  lastCheckTs: number;
  lastArchivedAt: number;
  bootstrapDone: boolean;
}

type LoadObserverStateResult =
  | { status: 'ok'; state: ObserverStateV3 }
  | { status: 'first_run'; state: ObserverStateV3 }
  | { status: 'corrupt'; reason: string };

function defaultObserverState(): ObserverStateV3 {
  return {
    version: STATE_SCHEMA_VERSION,
    lastCheckTs: 0,
    lastArchivedAt: 0,
    bootstrapDone: false,
  };
}

function isValidV3State(obj: Record<string, unknown>): obj is Record<string, unknown> & ObserverStateV3 {
  return (
    obj.version === STATE_SCHEMA_VERSION &&
    typeof obj.lastCheckTs === 'number' &&
    typeof obj.lastArchivedAt === 'number' &&
    typeof obj.bootstrapDone === 'boolean'
  );
}

function loadObserverState(fs: FileSystem, stateFile: string, _audit: AuditLog): LoadObserverStateResult {
  let raw: string;
  try {
    raw = fs.readSync(stateFile);
  } catch (err) {
    if (isFileNotFound(err)) {
      return { status: 'first_run', state: defaultObserverState() };
    }
    const reason = `read_failed:${(err as NodeJS.ErrnoException)?.code ?? 'unknown'}:${formatErr(err)}`;
    return { status: 'corrupt', reason };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const reason = `json_parse_failed:${formatErr(err)}`;
    return { status: 'corrupt', reason };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    const reason = 'schema_mismatch:not_an_object';
    return { status: 'corrupt', reason };
  }

  const obj = parsed as Record<string, unknown>;

  // v3 schema
  if (isValidV3State(obj)) {
    return { status: 'ok', state: obj };
  }

  // v2 → v3 migration: 旧 set 无法可靠转水位线， conservatively 用 lastCheckTs 作初始水位、
  // bootstrap=false 首 tick 不 emit 只更新水位。
  if (obj.version === 2 && typeof obj.lastCheckTs === 'number') {
    return {
      status: 'ok',
      state: {
        version: STATE_SCHEMA_VERSION,
        lastCheckTs: obj.lastCheckTs,
        lastArchivedAt: obj.lastCheckTs,
        bootstrapDone: false,
      },
    };
  }

  // v1 → v3 migration: 只有 lastCheckTs
  if (typeof obj.lastCheckTs === 'number') {
    return {
      status: 'ok',
      state: {
        version: STATE_SCHEMA_VERSION,
        lastCheckTs: obj.lastCheckTs,
        lastArchivedAt: obj.lastCheckTs,
        bootstrapDone: false,
      },
    };
  }

  const reason = 'schema_mismatch:shape_mismatch';
  return { status: 'corrupt', reason };
}

export async function runContractObserver(options: ContractObserverOptions): Promise<void> {
  const { clawTopology, motionDir, fs, motionAudit, notifyMotion } = options;

  // phase 37: tickStart 在 scan 开始捕获、写为 lastCheckTs（不再 end-of-scan now、关 race window）
  const tickStart = Date.now();

  const stateFile = path.join(motionDir, STATE_FILE);
  const loaded = loadObserverState(fs, stateFile, motionAudit);
  if (loaded.status === 'corrupt') {
    motionAudit.write(
      CONTRACT_AUDIT_EVENTS.OBSERVER_STATE_LOAD_FAILED,
      `file=${stateFile}`,
      `reason=${loaded.reason}`,
    );
    throw new Error(`Observer state corrupt: ${loaded.reason}`);
  }
  const state = loaded.state;
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
  const cancellations: Array<{ source_claw: string; contract_id: string; reason: string }> = [];
  const crashes: Array<{ source_claw: string; contract_id: string; cause: string }> = [];
  let maxArchivedAt = state.lastArchivedAt;

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
        const archivedAt = entry.latestSubtaskCompletedAtMs;
        if (archivedAt <= state.lastArchivedAt) continue;  // 水位线去重：已处理
        if (archivedAt > maxArchivedAt) {
          maxArchivedAt = archivedAt;
        }
        // bootstrap 期不 emit、仅更新水位（防首次启动历史 archive 大量重 emit）
        if (state.bootstrapDone) {
          switch (entry.status) {
            case 'completed':
              completedEvents.push(entry.body);
              if (entry.hasFailure) allProblemPairs.push(`${clawId}:${entry.contractId}`);
              // phase 821: fire-and-forget 触发契约复盘，失败不阻塞 observer
              if (options.onCompletedContract) {
                options.onCompletedContract(clawId, entry.contractId).catch(err => {
                  motionAudit.write(
                    CONTRACT_AUDIT_EVENTS.OBSERVER_EVENT_FAILED,
                    `claw=${clawId}`,
                    `contract=${entry.contractId}`,
                    `reason=retro_callback_failed`,
                    `error=${formatErr(err)}`,
                  );
                });
              }
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
            default: {
              const _exhaustive: never = entry.status;
              return _exhaustive;
            }
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

  // 分流投递 3 个独立 notifyMotion 调用（type 不同）
  // phase 946: 先全部投递成功，再写 state；任何失败 → state 不更新、下次重试。
  if (state.bootstrapDone) {
    const notifications: Promise<void>[] = [];

    if (completedEvents.length > 0) {
      notifications.push(notifyMotion({
        type: 'contract_events',
        source: 'system',
        priority: 'high',
        body: completedEvents.join('\n\n'),
        extraFields: {
          problem_pairs: allProblemPairs.join(','),
        },
      }));
    }

    if (cancelledEvents.length > 0) {
      notifications.push(notifyMotion({
        type: 'contract_cancelled',
        source: 'system',
        priority: 'high',
        body: cancelledEvents.join('\n\n'),
        extraFields: {
          cancellations: JSON.stringify(cancellations),
        },
      }));
    }

    if (crashedEvents.length > 0) {
      notifications.push(notifyMotion({
        type: 'contract_crashed',
        source: 'system',
        priority: 'high',
        body: crashedEvents.join('\n\n'),
        extraFields: {
          crashes: JSON.stringify(crashes),
        },
      }));
    }

    if (notifications.length > 0) {
      await Promise.all(notifications);
    }
  }

  // 全部通知投递成功（或 bootstrap 期无通知）→ 更新 state
  const newState: ObserverStateV3 = {
    version: STATE_SCHEMA_VERSION,
    lastCheckTs: tickStart,  // phase 37: tickStart 不是 end-of-scan now
    lastArchivedAt: maxArchivedAt,
    bootstrapDone: true,     // 首 tick 后总是 true
  };
  fs.ensureDirSync(path.dirname(stateFile));
  fs.writeAtomicSync(stateFile, JSON.stringify(newState));

  // bootstrap 完成的 trace
  if (wasBootstrapPending) {
    motionAudit.write(
      CONTRACT_AUDIT_EVENTS.OBSERVER_BOOTSTRAP_DONE,
      `lastArchivedAt=${newState.lastArchivedAt}`,
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
