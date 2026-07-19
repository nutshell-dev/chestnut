import * as path from 'path';
import { formatErr } from "../../../foundation/node-utils/index.js";
import { isFileNotFound, type FileSystem } from '../../../foundation/fs/index.js';
import type { AuditLog } from '../../../foundation/audit/index.js';
import type { ClawTopology } from '../../../core/claw-topology/index.js';
import type { InboxMessageOptionsBase } from '../../../foundation/messaging/index.js';
import { scanArchivedContracts } from './event-collector.js';
import { CONTRACT_AUDIT_EVENTS } from '../audit-events.js';
import {
  emitContractLegacyCrashedObserved,
} from '../audit-emit.js';
import { CONTRACT_ARCHIVE_DIR } from '../dirs.js';
import { ARCHIVE_STATES } from '../types.js';

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

// 持久化文件：observer 状态（lastCheckTs metric + per-claw 水位线 + bootstrap marker + 投递 watermark）
const STATE_FILE = 'status/contract-observer-state.json';

/**
 * Persisted observer state schema 版本号.
 * Derivation: 1 → 2 在 phase 37 引入 dedup-based 通知去重（替代 lastCheckTs hard filter）;
 * 2 → 3 在 phase 946 改为基于 archive timestamp 的水位线去重、移除有界 set;
 * 3 → 4 在 phase 948 引入 per-claw 水位 + 复合游标 + 逐类投递幂等标记;
 * 4 → 5 在 phase 950 将 per-claw 水位改为复合游标、将 boolean 投递标记改为 per-status watermark。
 * 5 → 6 在 phase 981 引入 per-claw corrupt / active-state contract audit dedup sets，抑制重复 audit spam。
 */
const STATE_SCHEMA_VERSION = 6;

interface ClawWatermarkCursor {
  archivedAt: number;
  lastContractId: string;
}

/**
 * phase 950: state schema v5（仅用于迁移校验）。
 * - clawWatermarks: 每个 claw 的复合游标 `{ archivedAt, lastContractId }`，
 *   解决同毫秒多个 contract 的确定性去重。
 * - bootstrapDone: false = 首 tick 仅更新水位、不 emit（防首次启动历史 archive 大量重 emit）。
 * - lastCheckTs: 仅 metric / debug 用。
 * - completedWatermarks / cancelledWatermarks / crashedWatermarks: 每个 claw 每类事件
 *   已成功通知的最大复合游标。替代 boolean 标记，避免新 batch 被旧 batch 标记吃掉，
 *   同时避免全局 watermark 导致的跨 claw 压制。
 * - lastArchivedAt (可选): v3/v4 迁移时的全局水位回退，新写入状态不再携带。
 */
interface ObserverStateV5 {
  version: 5;
  lastCheckTs: number;
  /** v3/v4 迁移残留，用于在 claw 尚无 per-claw 水位时回退 */
  lastArchivedAt?: number;
  clawWatermarks: Record<string, ClawWatermarkCursor>;
  bootstrapDone: boolean;
  completedWatermarks: Record<string, ClawWatermarkCursor>;
  cancelledWatermarks: Record<string, ClawWatermarkCursor>;
  crashedWatermarks: Record<string, ClawWatermarkCursor>;
}

/**
 * phase 981: state schema v6。
 * 在 v5 基础上新增 reportedCorrupted / reportedActiveState：每个 claw 已审计的 contract id 列表，
 * 避免同一 corrupt / active-state contract 在每个 cron tick 重复产生 audit。
 */
interface ObserverStateV6 {
  version: 6;
  lastCheckTs: number;
  /** v3/v4 迁移残留，用于在 claw 尚无 per-claw 水位时回退 */
  lastArchivedAt?: number;
  clawWatermarks: Record<string, ClawWatermarkCursor>;
  bootstrapDone: boolean;
  completedWatermarks: Record<string, ClawWatermarkCursor>;
  cancelledWatermarks: Record<string, ClawWatermarkCursor>;
  crashedWatermarks: Record<string, ClawWatermarkCursor>;
  /** v6: 每个 claw 已报告 PROGRESS_CORRUPTED 的 contract id 列表 */
  reportedCorrupted: Record<string, string[]>;
  /** v6: 每个 claw 已报告 CONTRACT_ARCHIVE_ACTIVE_STATE_DETECTED 的 contract id 列表 */
  reportedActiveState: Record<string, string[]>;
}

type LoadObserverStateResult =
  | { status: 'ok'; state: ObserverStateV6 }
  | { status: 'first_run'; state: ObserverStateV6 }
  | { status: 'corrupt'; reason: string };

function defaultObserverState(): ObserverStateV6 {
  return {
    version: STATE_SCHEMA_VERSION,
    lastCheckTs: 0,
    clawWatermarks: {},
    bootstrapDone: false,
    completedWatermarks: {},
    cancelledWatermarks: {},
    crashedWatermarks: {},
    reportedCorrupted: {},
    reportedActiveState: {},
  };
}

function isCompositeCursor(v: unknown): v is ClawWatermarkCursor {
  return (
    typeof v === 'object' &&
    v !== null &&
    'archivedAt' in v &&
    typeof (v as Record<string, unknown>).archivedAt === 'number' &&
    'lastContractId' in v &&
    typeof (v as Record<string, unknown>).lastContractId === 'string'
  );
}

function isValidV5State(obj: Record<string, unknown>): obj is Record<string, unknown> & ObserverStateV5 {
  const isCursorRecord = (v: unknown) =>
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    Object.values(v as Record<string, unknown>).every(isCompositeCursor);

  return (
    obj.version === 5 &&
    typeof obj.lastCheckTs === 'number' &&
    (obj.lastArchivedAt === undefined || typeof obj.lastArchivedAt === 'number') &&
    typeof obj.clawWatermarks === 'object' &&
    obj.clawWatermarks !== null &&
    isCursorRecord(obj.clawWatermarks) &&
    typeof obj.bootstrapDone === 'boolean' &&
    typeof obj.completedWatermarks === 'object' &&
    obj.completedWatermarks !== null &&
    isCursorRecord(obj.completedWatermarks) &&
    typeof obj.cancelledWatermarks === 'object' &&
    obj.cancelledWatermarks !== null &&
    isCursorRecord(obj.cancelledWatermarks) &&
    typeof obj.crashedWatermarks === 'object' &&
    obj.crashedWatermarks !== null &&
    isCursorRecord(obj.crashedWatermarks)
  );
}

function isValidV6State(obj: Record<string, unknown>): obj is Record<string, unknown> & ObserverStateV6 {
  const isCursorRecord = (v: unknown) =>
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    Object.values(v as Record<string, unknown>).every(isCompositeCursor);

  const isStringArrayRecord = (v: unknown) =>
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    Object.values(v as Record<string, unknown>).every(
      arr => Array.isArray(arr) && arr.every(item => typeof item === 'string'),
    );

  return (
    obj.version === STATE_SCHEMA_VERSION &&
    typeof obj.lastCheckTs === 'number' &&
    (obj.lastArchivedAt === undefined || typeof obj.lastArchivedAt === 'number') &&
    typeof obj.clawWatermarks === 'object' &&
    obj.clawWatermarks !== null &&
    isCursorRecord(obj.clawWatermarks) &&
    typeof obj.bootstrapDone === 'boolean' &&
    typeof obj.completedWatermarks === 'object' &&
    obj.completedWatermarks !== null &&
    isCursorRecord(obj.completedWatermarks) &&
    typeof obj.cancelledWatermarks === 'object' &&
    obj.cancelledWatermarks !== null &&
    isCursorRecord(obj.cancelledWatermarks) &&
    typeof obj.crashedWatermarks === 'object' &&
    obj.crashedWatermarks !== null &&
    isCursorRecord(obj.crashedWatermarks) &&
    typeof obj.reportedCorrupted === 'object' &&
    obj.reportedCorrupted !== null &&
    isStringArrayRecord(obj.reportedCorrupted) &&
    typeof obj.reportedActiveState === 'object' &&
    obj.reportedActiveState !== null &&
    isStringArrayRecord(obj.reportedActiveState)
  );
}

function migrateV5ToV6(obj: Record<string, unknown> & ObserverStateV5): ObserverStateV6 {
  return {
    ...obj,
    version: 6,
    reportedCorrupted: {},
    reportedActiveState: {},
  };
}

function migrateV4ToV6(obj: Record<string, unknown>): ObserverStateV6 | null {
  if (
    obj.version !== 4 ||
    typeof obj.lastCheckTs !== 'number' ||
    typeof obj.bootstrapDone !== 'boolean' ||
    typeof obj.clawWatermarks !== 'object' ||
    obj.clawWatermarks === null ||
    Array.isArray(obj.clawWatermarks)
  ) {
    return null;
  }
  const legacyWatermarks = obj.clawWatermarks as Record<string, unknown>;
  const clawWatermarks: Record<string, ClawWatermarkCursor> = {};
  for (const [k, v] of Object.entries(legacyWatermarks)) {
    if (typeof v === 'number') {
      clawWatermarks[k] = { archivedAt: v, lastContractId: '' };
    } else if (isCompositeCursor(v)) {
      clawWatermarks[k] = v;
    }
  }
  const lastArchivedAt = typeof obj.lastArchivedAt === 'number' ? obj.lastArchivedAt : undefined;
  return {
    version: STATE_SCHEMA_VERSION,
    lastCheckTs: obj.lastCheckTs,
    lastArchivedAt,
    clawWatermarks,
    bootstrapDone: obj.bootstrapDone,
    completedWatermarks: {},
    cancelledWatermarks: {},
    crashedWatermarks: {},
    reportedCorrupted: {},
    reportedActiveState: {},
  };
}

function migrateV3ToV6(obj: Record<string, unknown>): ObserverStateV6 | null {
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
    completedWatermarks: {},
    cancelledWatermarks: {},
    crashedWatermarks: {},
    reportedCorrupted: {},
    reportedActiveState: {},
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

  // v6 schema
  if (isValidV6State(obj)) {
    return { status: 'ok', state: obj };
  }

  // v5 → v6 migration: 新增 dedup sets，默认空。
  if (isValidV5State(obj)) {
    return { status: 'ok', state: migrateV5ToV6(obj) };
  }

  // v4 → v6 migration: 复合游标 + per-status watermark + 空 dedup sets。
  const v6FromV4 = migrateV4ToV6(obj);
  if (v6FromV4) {
    return { status: 'ok', state: v6FromV4 };
  }

  // v3 → v6 migration: 全局水位退化为 lastArchivedAt 回退，per-claw 水位在首次 tick 按 claw 建立。
  const v6FromV3 = migrateV3ToV6(obj);
  if (v6FromV3) {
    return { status: 'ok', state: v6FromV3 };
  }

  // v2 → v6 migration: 旧 set 无法可靠转水位线，conservatively 用 lastCheckTs 作全局回退、
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
        completedWatermarks: {},
        cancelledWatermarks: {},
        crashedWatermarks: {},
        reportedCorrupted: {},
        reportedActiveState: {},
      },
    };
  }

  // v1 → v6 migration: 只有 lastCheckTs
  if (typeof obj.lastCheckTs === 'number') {
    return {
      status: 'ok',
      state: {
        version: STATE_SCHEMA_VERSION,
        lastCheckTs: obj.lastCheckTs,
        lastArchivedAt: obj.lastCheckTs,
        clawWatermarks: {},
        bootstrapDone: false,
        completedWatermarks: {},
        cancelledWatermarks: {},
        crashedWatermarks: {},
        reportedCorrupted: {},
        reportedActiveState: {},
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
  // recoveryEvents / crashedEvents 删除（phase 197/1121: 不再投 motion、改 emit audit）
  const allProblemPairs: string[] = [];
  const cancellations: Array<{ source_claw: string; contract_id: string; reason: string }> = [];

  // phase 950: per-claw 复合游标水位；任一 claw 扫描不完整或失败 → 该 claw 水位不推进，其他 claw 独立推进。
  const nextClawWatermarks: Record<string, ClawWatermarkCursor> = { ...state.clawWatermarks };
  const fallbackCursor: ClawWatermarkCursor | undefined =
    state.lastArchivedAt !== undefined
      ? { archivedAt: state.lastArchivedAt, lastContractId: '' }
      : undefined;

  // phase 950: 本批次每 claw 每类事件的最大复合游标，用于成功后推进 per-claw per-status watermark。
  const batchCompletedCursors: Record<string, ClawWatermarkCursor> = {};
  const batchCancelledCursors: Record<string, ClawWatermarkCursor> = {};

  function isCursorGreater(a: ClawWatermarkCursor, b: ClawWatermarkCursor): boolean {
    if (a.archivedAt !== b.archivedAt) return a.archivedAt > b.archivedAt;
    return a.lastContractId.localeCompare(b.lastContractId) > 0;
  }

  function shouldProcessEntry(entry: { archivedAt: number; contractId: string }, cursor?: ClawWatermarkCursor): boolean {
    if (!cursor) return true;
    if (entry.archivedAt < cursor.archivedAt) return false;
    if (entry.archivedAt === cursor.archivedAt && entry.contractId <= cursor.lastContractId) return false;
    return true;
  }

  for (const clawId of clawIds) {
    if (options.signal?.aborted) return;
    try {
      const location = clawTopology.resolve(makeClawId(clawId));
      if (location.kind !== 'local') continue;
      // phase 1127 Step C: 显式预检所有 archive 容器可读性；scanArchivedContracts 内部吞掉非 ENOENT 错误，
      // 这里重新探测，使扫描失败能被 catch、该 claw 水位不推进。
      const archiveDir = path.join(location.clawDir, CONTRACT_ARCHIVE_DIR);
      const stateDirs = [...ARCHIVE_STATES].map(state => `${archiveDir}/${state}`);
      const readableContainers = [archiveDir, ...stateDirs].filter(d => fs.existsSync(d));
      try {
        for (const d of readableContainers) {
          fs.listSync(d, { includeDirs: true });
        }
      } catch (err) {
        if (isFileNotFound(err)) {
          // 容器在 existsSync 与 listSync 之间消失视为空扫描，不推进水位
          continue;
        }
        throw err;
      }
      // phase 981: per-claw audit dedup sets，避免同一 corrupt / active-state contract 每个 tick 重复 audit。
      const corruptedSet = new Set(state.reportedCorrupted[clawId] ?? []);
      const activeStateSet = new Set(state.reportedActiveState[clawId] ?? []);

      const { entries, incomplete } = await scanArchivedContracts(fs, location.clawDir, makeClawId(clawId), motionAudit, {
        corrupted: corruptedSet,
        activeState: activeStateSet,
      });

      // 保存本 claw 本次 scan 后的 dedup 状态（即使 incomplete，已报告的 contract 也应被记住）。
      state.reportedCorrupted[clawId] = [...corruptedSet];
      state.reportedActiveState[clawId] = [...activeStateSet];

      // phase 950: 扫描不完整 → 跳过该 claw、不推进水位、写 audit。
      if (incomplete) {
        motionAudit.write(
          CONTRACT_AUDIT_EVENTS.OBSERVER_EVENT_FAILED,
          `claw=${clawId}`,
          `reason=scan_incomplete`,
        );
        continue;
      }

      // phase 948/950: 复合游标排序（archivedAt, contractId）确保同毫秒契约确定性处理
      const sortedEntries = [...entries].sort((a, b) => {
        const ta = a.archivedAt;
        const tb = b.archivedAt;
        if (ta !== tb) return ta - tb;
        return a.contractId.localeCompare(b.contractId);
      });

      const prevCursor = state.clawWatermarks[clawId] ?? fallbackCursor;
      let nextCursor: ClawWatermarkCursor | undefined = prevCursor;

      for (const entry of sortedEntries) {
        try {
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
          // phase 950: 复合游标过滤；同 timestamp 按 contractId 严格大于 lastContractId 才处理
          if (!shouldProcessEntry(entry, prevCursor)) continue;
          // 更新该 claw 本次 scan 的游标（entries 已排序，最后一个被处理的 entry 即为最大值）
          nextCursor = { archivedAt: entry.archivedAt, lastContractId: entry.contractId };
          // bootstrap 期不 emit、仅更新水位（防首次启动历史 archive 大量重 emit）
          if (state.bootstrapDone) {
            switch (entry.status) {
              case 'completed': {
                const statusCursor = state.completedWatermarks[clawId];
                if (shouldProcessEntry(entry, statusCursor)) {
                  completedEvents.push(entry.body);
                  if (entry.hasFailure) allProblemPairs.push(`${clawId}:${entry.contractId}`);
                  const current = batchCompletedCursors[clawId];
                  if (!current || isCursorGreater({ archivedAt: entry.archivedAt, lastContractId: entry.contractId }, current)) {
                    batchCompletedCursors[clawId] = { archivedAt: entry.archivedAt, lastContractId: entry.contractId };
                  }
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
                }
                break;
              }
              case 'cancelled': {
                const statusCursor = state.cancelledWatermarks[clawId];
                if (shouldProcessEntry(entry, statusCursor)) {
                  cancelledEvents.push(entry.body);
                  cancellations.push({
                    source_claw: clawId,
                    contract_id: entry.contractId,
                    reason: entry.reason ?? '(no reason given)',
                  });
                  const current = batchCancelledCursors[clawId];
                  if (!current || isCursorGreater({ archivedAt: entry.archivedAt, lastContractId: entry.contractId }, current)) {
                    batchCancelledCursors[clawId] = { archivedAt: entry.archivedAt, lastContractId: entry.contractId };
                  }
                }
                break;
              }
              case 'crashed': {
                // phase 1121 Step D: historical status=crashed 只产生 legacy audit、不生成 motion 业务决策
                emitContractLegacyCrashedObserved(motionAudit, {
                  clawId: makeClawId(clawId),
                  contractId: entry.contractId,
                  sourcePath: path.join(location.clawDir, CONTRACT_ARCHIVE_DIR, entry.contractId),
                });
                break;
              }
              case 'corrupted':
                // Step F: corrupted archive state is terminal; no motion delivery.
                break;

              default: {
                const _exhaustive: never = entry.status;
                return _exhaustive;
              }
            }
          }
        } catch (err) {
          // Phase 969: per-entry isolation — one bad entry must not abort the whole claw scan
          motionAudit.write(
            CONTRACT_AUDIT_EVENTS.OBSERVER_EVENT_FAILED,
            `claw=${clawId}`,
            `contract=${entry.contractId}`,
            `reason=entry_processing_failed`,
            `error=${formatErr(err)}`,
          );
          // continue to next entry
        }
      }

      // 扫描成功 → 在内存中推进该 claw 复合游标（最终是否持久化取决于投递是否全部成功）
      if (nextCursor) {
        nextClawWatermarks[clawId] = nextCursor;
      }
    } catch (e) {
      motionAudit.write(
        CONTRACT_AUDIT_EVENTS.OBSERVER_EVENT_FAILED,
        `claw=${clawId}`,
        `reason=${formatErr(e)}`
      );
    }
  }

  // phase 950: per-claw per-status watermark 替代 boolean 标记。
  const nextCompletedWatermarks: Record<string, ClawWatermarkCursor> = { ...state.completedWatermarks };
  const nextCancelledWatermarks: Record<string, ClawWatermarkCursor> = { ...state.cancelledWatermarks };

  // 分流投递 2 个独立 notifyMotion 调用（type 不同）
  // phase 948/950: 逐类独立 try/catch；部分成功时推进成功类的 watermark，失败类下次重试。
  interface DeliveryFailure { type: string; error: unknown }
  const deliveryFailures: DeliveryFailure[] = [];

  if (state.bootstrapDone) {
    if (completedEvents.length > 0) {
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
        for (const [clawId, cursor] of Object.entries(batchCompletedCursors)) {
          nextCompletedWatermarks[clawId] = cursor;
        }
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

    if (cancelledEvents.length > 0) {
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
        for (const [clawId, cursor] of Object.entries(batchCancelledCursors)) {
          nextCancelledWatermarks[clawId] = cursor;
        }
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

  }

  function statusWatermarksAdvanced(
    next: Record<string, ClawWatermarkCursor>,
    prev: Record<string, ClawWatermarkCursor>,
  ): boolean {
    for (const clawId of Object.keys(next)) {
      const n = next[clawId];
      const p = prev[clawId];
      if (!p) return true;
      if (isCursorGreater(n, p)) return true;
    }
    return false;
  }

  const completedSuccess = completedEvents.length === 0 || statusWatermarksAdvanced(nextCompletedWatermarks, state.completedWatermarks);
  const cancelledSuccess = cancelledEvents.length === 0 || statusWatermarksAdvanced(nextCancelledWatermarks, state.cancelledWatermarks);
  const allDeliveriesSucceeded = completedSuccess && cancelledSuccess;
  const anyDeliverySucceeded =
    (completedEvents.length > 0 && statusWatermarksAdvanced(nextCompletedWatermarks, state.completedWatermarks)) ||
    (cancelledEvents.length > 0 && statusWatermarksAdvanced(nextCancelledWatermarks, state.cancelledWatermarks));

  // phase 948/950: 只有全部投递成功（或 bootstrap 无投递 / 无事件）才推进 per-claw 水位；
  // 部分成功时保留旧 per-claw 水位，但已成功类别的 per-claw per-status watermark 会推进；
  // 全部失败时沿用 phase 946 语义：抛错、不写 state，由 cron 重试。
  if (anyDeliverySucceeded || allDeliveriesSucceeded) {
    const newState: ObserverStateV6 = {
      version: STATE_SCHEMA_VERSION,
      lastCheckTs: tickStart,
      clawWatermarks: allDeliveriesSucceeded ? nextClawWatermarks : state.clawWatermarks,
      bootstrapDone: true,
      completedWatermarks: nextCompletedWatermarks,
      cancelledWatermarks: nextCancelledWatermarks,
      crashedWatermarks: state.crashedWatermarks,
      reportedCorrupted: state.reportedCorrupted,
      reportedActiveState: state.reportedActiveState,
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
