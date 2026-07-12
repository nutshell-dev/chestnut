import * as path from 'path';
import { formatErr } from "../../../foundation/node-utils/index.js";
import { isFileNotFound, type FileSystem } from '../../../foundation/fs/index.js';
import type { AuditLog } from '../../../foundation/audit/index.js';
import type { ClawTopology } from '../../../core/claw-topology/index.js';
import type { InboxMessageOptionsBase } from '../../../foundation/messaging/index.js';
import { scanArchivedContracts } from './event-collector.js';
import { CONTRACT_AUDIT_EVENTS } from '../audit-events.js';
import { emitContractArchiveRecoveryPendingObserved } from '../audit-emit.js';
import { CONTRACT_ARCHIVE_DIR } from '../dirs.js';

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

// 持久化文件：observer 状态（lastCheckTs metric + per-claw 水位线 + bootstrap marker + 投递幂等标记）
const STATE_FILE = 'status/contract-observer-state.json';

/**
 * Persisted observer state schema 版本号.
 * Derivation: 1 → 2 在 phase 37 引入 dedup-based 通知去重（替代 lastCheckTs hard filter）;
 * 2 → 3 在 phase 946 改为基于 archive timestamp 的水位线去重、移除有界 set;
 * 3 → 4 在 phase 948 引入 per-claw 水位 + 复合游标 + 逐类投递幂等标记。
 */
const STATE_SCHEMA_VERSION = 4;

/**
 * phase 948: state schema v4 治 observer 循环重发 / 通知丢失 / 状态损坏静默。
 * - clawWatermarks: 每个 claw 独立的上次成功通知最大 archive timestamp 水位线。
 * - bootstrapDone: false = 首 tick 仅更新水位、不 emit（防首次启动历史 archive 大量重 emit）。
 * - lastCheckTs: 仅 metric / debug 用。
 * - completedNotified / cancelledNotified / crashedNotified: 当前 batch 各类投递状态，
 *   部分投递成功时持久化以避免已成功的类别被重复投递。
 * - lastArchivedAt (可选): v3 → v4 迁移时的全局水位回退，新写入状态不再携带。
 */
interface ObserverStateV4 {
  version: 4;
  lastCheckTs: number;
  /** v3 迁移残留，用于在 claw 尚无 per-claw 水位时回退 */
  lastArchivedAt?: number;
  clawWatermarks: Record<string, number>;
  bootstrapDone: boolean;
  completedNotified: boolean;
  cancelledNotified: boolean;
  crashedNotified: boolean;
}

type LoadObserverStateResult =
  | { status: 'ok'; state: ObserverStateV4 }
  | { status: 'first_run'; state: ObserverStateV4 }
  | { status: 'corrupt'; reason: string };

function defaultObserverState(): ObserverStateV4 {
  return {
    version: STATE_SCHEMA_VERSION,
    lastCheckTs: 0,
    clawWatermarks: {},
    bootstrapDone: false,
    completedNotified: false,
    cancelledNotified: false,
    crashedNotified: false,
  };
}

function isValidV4State(obj: Record<string, unknown>): obj is Record<string, unknown> & ObserverStateV4 {
  return (
    obj.version === STATE_SCHEMA_VERSION &&
    typeof obj.lastCheckTs === 'number' &&
    (obj.lastArchivedAt === undefined || typeof obj.lastArchivedAt === 'number') &&
    typeof obj.clawWatermarks === 'object' &&
    obj.clawWatermarks !== null &&
    !Array.isArray(obj.clawWatermarks) &&
    Object.values(obj.clawWatermarks).every(v => typeof v === 'number') &&
    typeof obj.bootstrapDone === 'boolean' &&
    typeof obj.completedNotified === 'boolean' &&
    typeof obj.cancelledNotified === 'boolean' &&
    typeof obj.crashedNotified === 'boolean'
  );
}

function migrateV3ToV4(obj: Record<string, unknown>): ObserverStateV4 | null {
  if (
    obj.version !== 3 ||
    typeof obj.lastCheckTs !== 'number' ||
    typeof obj.lastArchivedAt !== 'number' ||
    typeof obj.bootstrapDone !== 'boolean'
  ) {
    return null;
  }
  return {
    version: STATE_SCHEMA_VERSION,
    lastCheckTs: obj.lastCheckTs,
    lastArchivedAt: obj.lastArchivedAt,
    clawWatermarks: {},
    bootstrapDone: obj.bootstrapDone,
    completedNotified: false,
    cancelledNotified: false,
    crashedNotified: false,
  };
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

  // v4 schema
  if (isValidV4State(obj)) {
    return { status: 'ok', state: obj };
  }

  // v3 → v4 migration: 全局水位退化为 lastArchivedAt 回退，per-claw 水位在首次 tick 按 claw 建立。
  const v4FromV3 = migrateV3ToV4(obj);
  if (v4FromV3) {
    return { status: 'ok', state: v4FromV3 };
  }

  // v2 → v4 migration: 旧 set 无法可靠转水位线，conservatively 用 lastCheckTs 作全局回退、
  // bootstrap=false 首 tick 不 emit 只更新水位。
  if (obj.version === 2 && typeof obj.lastCheckTs === 'number') {
    return {
      status: 'ok',
      state: {
        version: STATE_SCHEMA_VERSION,
        lastCheckTs: obj.lastCheckTs,
        lastArchivedAt: obj.lastCheckTs,
        clawWatermarks: {},
        bootstrapDone: false,
        completedNotified: false,
        cancelledNotified: false,
        crashedNotified: false,
      },
    };
  }

  // v1 → v4 migration: 只有 lastCheckTs
  if (typeof obj.lastCheckTs === 'number') {
    return {
      status: 'ok',
      state: {
        version: STATE_SCHEMA_VERSION,
        lastCheckTs: obj.lastCheckTs,
        lastArchivedAt: obj.lastCheckTs,
        clawWatermarks: {},
        bootstrapDone: false,
        completedNotified: false,
        cancelledNotified: false,
        crashedNotified: false,
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

  // phase 948: per-claw 水位；任一 claw 扫描失败 → 该 claw 水位不推进，其他 claw 独立推进。
  const nextClawWatermarks: Record<string, number> = { ...state.clawWatermarks };
  const fallbackWatermark = state.lastArchivedAt ?? 0;

  for (const clawId of clawIds) {
    if (options.signal?.aborted) return;
    try {
      const location = clawTopology.resolve(makeClawId(clawId));
      if (location.kind !== 'local') continue;
      // phase 948: 显式预检 archive dir 可读性；scanArchivedContracts 内部吞掉非 ENOENT 错误，
      // 这里重新探测，使扫描失败能被 catch、该 claw 水位不推进。
      const archiveDir = path.join(location.clawDir, CONTRACT_ARCHIVE_DIR);
      try {
        fs.listSync(archiveDir, { includeDirs: true });
      } catch (err) {
        if (isFileNotFound(err)) {
          // archive dir 不存在视为空扫描，不推进水位
          continue;
        }
        throw err;
      }
      const entries = scanArchivedContracts(fs, location.clawDir, makeClawId(clawId), motionAudit);
      // phase 948: 复合游标排序（archivedAt, contractId）确保同毫秒契约确定性处理
      const sortedEntries = [...entries].sort((a, b) => {
        const ta = a.archivedAt;
        const tb = b.archivedAt;
        if (ta !== tb) return ta - tb;
        return a.contractId.localeCompare(b.contractId);
      });

      const clawWatermark = state.clawWatermarks[clawId] ?? fallbackWatermark;
      let clawMax = clawWatermark;

      for (const entry of sortedEntries) {
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
        const archivedAt = entry.archivedAt;
        // phase 948: per-claw 开区间水位；同 timestamp 批次在单次 scan 内全部处理
        if (archivedAt <= clawWatermark) continue;
        if (archivedAt > clawMax) {
          clawMax = archivedAt;
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
            case 'pending':
            case 'running':
            case 'paused':
              // phase 949: active status in archive 已在 collector 层审计；observer 只跳过、不投 inbox
              motionAudit.write(
                CONTRACT_AUDIT_EVENTS.CONTRACT_ARCHIVE_ACTIVE_STATE_DETECTED,
                `claw=${clawId}`,
                `contract=${entry.contractId}`,
                `status=${entry.status}`,
                `context=observer_skip_active_in_archive`,
              );
              break;
            default: {
              const _exhaustive: never = entry.status;
              return _exhaustive;
            }
          }
        }
      }

      // 扫描成功 → 在内存中推进该 claw 水位（最终是否持久化取决于投递是否全部成功）
      nextClawWatermarks[clawId] = clawMax;
    } catch (e) {
      motionAudit.write(
        CONTRACT_AUDIT_EVENTS.OBSERVER_EVENT_FAILED,
        `claw=${clawId}`,
        `reason=${formatErr(e)}`
      );
    }
  }

  // phase 948: 投递幂等状态：当某类无事件时重置标记；有事件时保留上次的成功/失败状态。
  let completedNotified = state.completedNotified;
  let cancelledNotified = state.cancelledNotified;
  let crashedNotified = state.crashedNotified;

  if (completedEvents.length === 0) completedNotified = false;
  if (cancelledEvents.length === 0) cancelledNotified = false;
  if (crashedEvents.length === 0) crashedNotified = false;

  // 分流投递 3 个独立 notifyMotion 调用（type 不同）
  // phase 948: 逐类独立 try/catch；部分成功时持久化成功类的标记，失败类下次重试。
  interface DeliveryFailure { type: string; error: unknown }
  const deliveryFailures: DeliveryFailure[] = [];

  if (state.bootstrapDone) {
    if (completedEvents.length > 0 && !completedNotified) {
      try {
        await notifyMotion({
          type: 'contract_events',
          source: 'system',
          priority: 'high',
          body: completedEvents.join('\n\n'),
          extraFields: {
            problem_pairs: allProblemPairs.join(','),
          },
        });
        completedNotified = true;
      } catch (err) {
        motionAudit.write(
          CONTRACT_AUDIT_EVENTS.OBSERVER_EVENT_FAILED,
          'type=contract_events',
          `reason=notify_failed`,
          `error=${formatErr(err)}`,
        );
        deliveryFailures.push({ type: 'contract_events', error: err });
      }
    }

    if (cancelledEvents.length > 0 && !cancelledNotified) {
      try {
        await notifyMotion({
          type: 'contract_cancelled',
          source: 'system',
          priority: 'high',
          body: cancelledEvents.join('\n\n'),
          extraFields: {
            cancellations: JSON.stringify(cancellations),
          },
        });
        cancelledNotified = true;
      } catch (err) {
        motionAudit.write(
          CONTRACT_AUDIT_EVENTS.OBSERVER_EVENT_FAILED,
          'type=contract_cancelled',
          `reason=notify_failed`,
          `error=${formatErr(err)}`,
        );
        deliveryFailures.push({ type: 'contract_cancelled', error: err });
      }
    }

    if (crashedEvents.length > 0 && !crashedNotified) {
      try {
        await notifyMotion({
          type: 'contract_crashed',
          source: 'system',
          priority: 'high',
          body: crashedEvents.join('\n\n'),
          extraFields: {
            crashes: JSON.stringify(crashes),
          },
        });
        crashedNotified = true;
      } catch (err) {
        motionAudit.write(
          CONTRACT_AUDIT_EVENTS.OBSERVER_EVENT_FAILED,
          'type=contract_crashed',
          `reason=notify_failed`,
          `error=${formatErr(err)}`,
        );
        deliveryFailures.push({ type: 'contract_crashed', error: err });
      }
    }
  }

  const completedSuccess = completedEvents.length === 0 || completedNotified;
  const cancelledSuccess = cancelledEvents.length === 0 || cancelledNotified;
  const crashedSuccess = crashedEvents.length === 0 || crashedNotified;
  const allDeliveriesSucceeded = completedSuccess && cancelledSuccess && crashedSuccess;
  const anyDeliverySucceeded =
    (completedEvents.length > 0 && completedNotified) ||
    (cancelledEvents.length > 0 && cancelledNotified) ||
    (crashedEvents.length > 0 && crashedNotified);

  // phase 948: 只有全部投递成功（或 bootstrap 无投递 / 无事件）才推进水位；
  // 部分成功时保留旧水位，仅持久化投递标记，让下次只重试失败类别；
  // 全部失败时沿用 phase 946 语义：抛错、不写 state，由 cron 重试。
  // 全部成功后 batch 结束，投递标记复位，供下一 batch 重新开始。
  if (anyDeliverySucceeded || allDeliveriesSucceeded) {
    const newState: ObserverStateV4 = {
      version: STATE_SCHEMA_VERSION,
      lastCheckTs: tickStart,
      clawWatermarks: allDeliveriesSucceeded ? nextClawWatermarks : state.clawWatermarks,
      bootstrapDone: true,
      completedNotified: allDeliveriesSucceeded ? false : completedNotified,
      cancelledNotified: allDeliveriesSucceeded ? false : cancelledNotified,
      crashedNotified: allDeliveriesSucceeded ? false : crashedNotified,
    };
    fs.ensureDirSync(path.dirname(stateFile));
    fs.writeAtomicSync(stateFile, JSON.stringify(newState));
  }

  if (deliveryFailures.length > 0 && !anyDeliverySucceeded) {
    throw deliveryFailures[0].error;
  }

  // bootstrap 完成的 trace
  if (wasBootstrapPending) {
    motionAudit.write(
      CONTRACT_AUDIT_EVENTS.OBSERVER_BOOTSTRAP_DONE,
      `clawWatermarks=${JSON.stringify(nextClawWatermarks)}`,
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
