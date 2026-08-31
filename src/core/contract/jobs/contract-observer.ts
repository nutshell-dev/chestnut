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
import { makeContractId } from '../types.js';
import {
  encodeContractEventsGuidance,
  type ContractEventGuidanceRef,
} from '../contract-events-guidance.js';
import {
  encodeContractCancelledGuidance,
  type ContractCancelledGuidanceRef,
} from '../contract-cancelled-guidance.js';

/** phase 101: DI callback - caller (装配期) bind fs + chestnutRoot + MOTION_CLAW_ID + audit */
type NotifyMotionFn = (message: InboxMessageOptionsBase) => Promise<void>;
import type { CronJob } from '../../../foundation/cron/index.js';
import { parseSchedule } from '../../../foundation/cron/index.js';
import type { CronJobGlobalConfig } from '../../../foundation/cron/index.js';
import { makeClawId } from '../../../foundation/claw-identity/index.js';


/**
 * Cron job timeout (ms) / 防 stuck handler 占 cron tick.
 * 由本 module 业务自决 (per M#2 模块为自己业务语义负责).
 */
export const CONTRACT_OBSERVER_CRON_TIMEOUT_MS = 5 * 60_000;

interface ContractObserverOptions {
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

interface ContractObserverJobDeps {
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
 * 6 → 7 在 Phase 1396 Step M 引入 retrospectiveWatermarks（与 Motion 通知的 completedWatermarks
 *   独立）；迁移时以已有 clawWatermarks 初始化，不回放上线前历史。
 */
const STATE_SCHEMA_VERSION = 7;

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

/**
 * Phase 1396 Step M: state schema v7。
 * 在 v6 基础上新增 retrospectiveWatermarks：每个 claw 已成功交付给 retrospective
 * 消费者（EvolutionSystem）的最大复合游标。与 completedWatermarks（Motion 通知）
 * 相互独立，任一方失败只重试该消费者；总 clawWatermarks 必须等两类消费者都越过。
 */
interface ObserverStateV7 {
  version: 7;
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
  /** v7: 每个 claw retrospective 交付水位（独立于 Motion 通知水位） */
  retrospectiveWatermarks: Record<string, ClawWatermarkCursor>;
}

type LoadObserverStateResult =
  | { status: 'ok'; state: ObserverStateV7 }
  | { status: 'first_run'; state: ObserverStateV7 }
  | { status: 'corrupt'; reason: string };

function defaultObserverState(): ObserverStateV7 {
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
    retrospectiveWatermarks: {},
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

function isValidV7State(obj: Record<string, unknown>): obj is Record<string, unknown> & ObserverStateV7 {
  return (
    isValidV6StateShape(obj, STATE_SCHEMA_VERSION) &&
    typeof obj.retrospectiveWatermarks === 'object' &&
    obj.retrospectiveWatermarks !== null &&
    isCursorRecord(obj.retrospectiveWatermarks)
  );
}

function isCursorRecord(v: unknown): boolean {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    Object.values(v as Record<string, unknown>).every(isCompositeCursor)
  );
}

/** v6 共有 shape（version 参数化，供 v6/v7 校验复用） */
function isValidV6StateShape(obj: Record<string, unknown>, version: number): boolean {
  const isStringArrayRecord = (v: unknown) =>
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    Object.values(v as Record<string, unknown>).every(
      arr => Array.isArray(arr) && arr.every(item => typeof item === 'string'),
    );

  return (
    obj.version === version &&
    typeof obj.lastCheckTs === 'number' &&
    (obj.lastArchivedAt === undefined || typeof obj.lastArchivedAt === 'number') &&
    isCursorRecord(obj.clawWatermarks) &&
    typeof obj.bootstrapDone === 'boolean' &&
    isCursorRecord(obj.completedWatermarks) &&
    isCursorRecord(obj.cancelledWatermarks) &&
    isCursorRecord(obj.crashedWatermarks) &&
    typeof obj.reportedCorrupted === 'object' &&
    obj.reportedCorrupted !== null &&
    isStringArrayRecord(obj.reportedCorrupted) &&
    typeof obj.reportedActiveState === 'object' &&
    obj.reportedActiveState !== null &&
    isStringArrayRecord(obj.reportedActiveState)
  );
}

function isValidV6State(obj: Record<string, unknown>): obj is Record<string, unknown> & ObserverStateV6 {
  return isValidV6StateShape(obj, 6);
}

/**
 * Phase 1396 Step M: v6 → v7。
 * retrospective 水位以已有 clawWatermarks 初始化 —— 上线前已扫过的历史 archive
 * 不补发 retro（与 bootstrap 语义一致：只观察从现在开始的事实）。
 */
function migrateV6ToV7(obj: Record<string, unknown> & ObserverStateV6): ObserverStateV7 {
  return {
    ...obj,
    version: STATE_SCHEMA_VERSION,
    retrospectiveWatermarks: { ...obj.clawWatermarks },
  };
}

function migrateV5ToV7(obj: Record<string, unknown> & ObserverStateV5): ObserverStateV7 {
  return {
    ...obj,
    version: STATE_SCHEMA_VERSION,
    reportedCorrupted: {},
    reportedActiveState: {},
    retrospectiveWatermarks: { ...obj.clawWatermarks },
  };
}

function migrateV4ToV7(obj: Record<string, unknown>): ObserverStateV7 | null {
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
    retrospectiveWatermarks: { ...clawWatermarks },
  };
}

function migrateV3ToV7(obj: Record<string, unknown>): ObserverStateV7 | null {
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
    retrospectiveWatermarks: {},
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

  // v7 schema
  if (isValidV7State(obj)) {
    return { status: 'ok', state: obj };
  }

  // v6 → v7 migration: retrospective 水位以 clawWatermarks 初始化（不回放历史）。
  if (isValidV6State(obj)) {
    return { status: 'ok', state: migrateV6ToV7(obj) };
  }

  // v5 → v7 migration: 新增 dedup sets（默认空）+ retrospective 水位初始化。
  if (isValidV5State(obj)) {
    return { status: 'ok', state: migrateV5ToV7(obj) };
  }

  // v4 → v7 migration: 复合游标 + per-status watermark + 空 dedup sets。
  const v7FromV4 = migrateV4ToV7(obj);
  if (v7FromV4) {
    return { status: 'ok', state: v7FromV4 };
  }

  // v3 → v7 migration: 全局水位退化为 lastArchivedAt 回退，per-claw 水位在首次 tick 按 claw 建立。
  const v7FromV3 = migrateV3ToV7(obj);
  if (v7FromV3) {
    return { status: 'ok', state: v7FromV3 };
  }

  // v2 → v7 migration: 旧 set 无法可靠转水位线，conservatively 用 lastCheckTs 作全局回退、
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
        retrospectiveWatermarks: {},
      },
    };
  }

  // v1 → v7 migration: 只有 lastCheckTs
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
        retrospectiveWatermarks: {},
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
  // Phase 1396 Step M: 扫描范围纳入 motion —— 所有 completed contract（无论是否
  // summon 来源）都是同一完成事实，统一走 retrospective 交付。
  let clawIds: string[];
  try {
    clawIds = clawTopology.enumerate();
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
  // phase 1261 Step B: typed guidance refs（只收 hasFailure completed contract），
  // 由 owner encoder 统一写 v1 wire（不再手写 legacy CSV dialect）。
  const guidanceRefs: ContractEventGuidanceRef[] = [];
  // phase 1262 Step B: cancelled guidance 同样改 typed refs，由 owner encoder 统一写
  // v1 wire（不再手写 cancellations JSON dialect；reason 已在 entry.body 持久化）。
  const cancelledGuidanceRefs: ContractCancelledGuidanceRef[] = [];

  // phase 950: per-claw 复合游标水位；任一 claw 扫描不完整或失败 → 该 claw 水位不推进，其他 claw 独立推进。
  const nextClawWatermarks: Record<string, ClawWatermarkCursor> = { ...state.clawWatermarks };
  const fallbackCursor: ClawWatermarkCursor | undefined =
    state.lastArchivedAt !== undefined
      ? { archivedAt: state.lastArchivedAt, lastContractId: '' }
      : undefined;

  // phase 950: 本批次每 claw 每类事件的最大复合游标，用于成功后推进 per-claw per-status watermark。
  const batchCompletedCursors: Record<string, ClawWatermarkCursor> = {};
  const batchCancelledCursors: Record<string, ClawWatermarkCursor> = {};

  // Phase 1396 Step M: retrospective 交付追踪 ——
  // batchRetroCursors: 每 claw 本 tick retro 成功前缀的最大游标；
  // retroBlockedCursor: 该 executor 首条 retro 失败的游标（后续 entry 本 tick 不再 retro）。
  const batchRetroCursors: Record<string, ClawWatermarkCursor> = {};
  const retroBlockedCursor: Record<string, ClawWatermarkCursor> = {};
  // 本 tick 每 claw 实际处理过的 entry（越过了 clawWatermarks），用于投递失败时
  // 计算总水位允许推进到的最长全消费者成功前缀。
  const processedEntries: Record<string, Array<{ cursor: ClawWatermarkCursor; status: string }>> = {};

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

  // phase 948/950: 逐类独立 try/catch；部分成功时推进成功类的 watermark，失败类下次重试。
  // Phase 1396 Step M: retro 交付失败同样计入 deliveryFailures（类型 contract_retro）。
  interface DeliveryFailure { type: string; error: unknown }
  const deliveryFailures: DeliveryFailure[] = [];

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
      processedEntries[clawId] = [];

      for (const entry of sortedEntries) {
        try {
          // phase 324 H11: 验 claw / contract id 字符集，防 `:` `,` `` ` `` `\n` 注入。
          // 不合规 id 跳过、不入 guidance refs / dedup set；audit 一条 OBSERVER_EVENT_FAILED。
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
          const entryCursor: ClawWatermarkCursor = { archivedAt: entry.archivedAt, lastContractId: entry.contractId };
          // 更新该 claw 本次 scan 的游标（entries 已排序，最后一个被处理的 entry 即为最大值）
          nextCursor = entryCursor;
          processedEntries[clawId].push({ cursor: entryCursor, status: entry.status });
          // bootstrap 期不 emit、仅更新水位（防首次启动历史 archive 大量重 emit）
          if (state.bootstrapDone) {
            switch (entry.status) {
              case 'completed': {
                const statusCursor = state.completedWatermarks[clawId];
                if (shouldProcessEntry(entry, statusCursor)) {
                  completedEvents.push(entry.body);
                  if (entry.hasFailure) {
                    guidanceRefs.push({
                      clawId: makeClawId(clawId),
                      contractId: makeContractId(entry.contractId),
                    });
                  }
                  const current = batchCompletedCursors[clawId];
                  if (!current || isCursorGreater(entryCursor, current)) {
                    batchCompletedCursors[clawId] = entryCursor;
                  }
                }
                // Phase 1396 Step M: retrospective 交付按 (archivedAt, contractId)
                // 顺序 await；水位独立于 Motion 通知；首条失败后停止该 executor
                // 本 tick 后续 retro 交付，保证 retro 水位只表示连续成功前缀。
                if (options.onCompletedContract && !retroBlockedCursor[clawId]) {
                  const retroCursor = state.retrospectiveWatermarks[clawId] ?? prevCursor;
                  if (shouldProcessEntry(entry, retroCursor)) {
                    try {
                      await options.onCompletedContract(clawId, entry.contractId);
                      const cur = batchRetroCursors[clawId];
                      if (!cur || isCursorGreater(entryCursor, cur)) {
                        batchRetroCursors[clawId] = entryCursor;
                      }
                    } catch (err) {
                      retroBlockedCursor[clawId] = entryCursor;
                      motionAudit.write(
                        CONTRACT_AUDIT_EVENTS.OBSERVER_EVENT_FAILED,
                        `claw=${clawId}`,
                        `contract=${entry.contractId}`,
                        `reason=retro_callback_failed`,
                        `error=${formatErr(err)}`,
                      );
                      deliveryFailures.push({ type: 'contract_retro', error: err });
                    }
                  }
                }
                break;
              }
              case 'cancelled': {
                const statusCursor = state.cancelledWatermarks[clawId];
                if (shouldProcessEntry(entry, statusCursor)) {
                  cancelledEvents.push(entry.body);
                  cancelledGuidanceRefs.push({
                    clawId: makeClawId(clawId),
                    contractId: makeContractId(entry.contractId),
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
              case 'failed':
                // Phase 1396 Step D: failed archive state is terminal; no motion
                // delivery here (reason/evidenceRef presentation happens via the
                // notification adapter; recovery decisions belong to later phases).
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
  // Phase 1396 Step M: retro 水位独立推进（仅成功前缀）；bootstrap tick 与总水位对齐，
  // 不为部署前全部历史契约补发 retro。
  const nextRetrospectiveWatermarks: Record<string, ClawWatermarkCursor> = { ...state.retrospectiveWatermarks };

  if (state.bootstrapDone) {
    if (completedEvents.length > 0) {
      try {
        await notifyMotion({
          type: 'contract_events',
          source: 'system',
          priority: 'high',
          body: completedEvents.join('\n\n'),
          // phase 1261 Step B: 空 refs 合法（正文覆盖全部 completed events，
          // guidance 只含 hasFailure 契约），照常投递与推进 watermark。
          extraFields: encodeContractEventsGuidance(guidanceRefs),
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
          // phase 1262 Step B: 投递条件保证 refs non-empty（一事件一 ref），
          // encoder 仍做 boundary validation。
          extraFields: encodeContractCancelledGuidance(cancelledGuidanceRefs),
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

  // Phase 1396 Step M: retro 成功前缀推进 retrospectiveWatermarks。
  for (const [clawId, cursor] of Object.entries(batchRetroCursors)) {
    nextRetrospectiveWatermarks[clawId] = cursor;
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
  const retroSuccess = deliveryFailures.every(f => f.type !== 'contract_retro');
  const retroAdvanced = Object.entries(batchRetroCursors).some(([clawId, cursor]) => {
    const prev = state.retrospectiveWatermarks[clawId];
    return !prev || isCursorGreater(cursor, prev);
  });
  const allDeliveriesSucceeded = completedSuccess && cancelledSuccess && retroSuccess;
  const anyDeliverySucceeded =
    (completedEvents.length > 0 && statusWatermarksAdvanced(nextCompletedWatermarks, state.completedWatermarks)) ||
    (cancelledEvents.length > 0 && statusWatermarksAdvanced(nextCancelledWatermarks, state.cancelledWatermarks)) ||
    retroAdvanced;

  // Phase 1396 Step M: 总 clawWatermarks 必须等 notification 与 retro 消费者都越过对应
  // entry；按每 claw 已处理 entry 序列计算最长全消费者成功前缀。
  const completedNotifyFailed = deliveryFailures.some(f => f.type === 'contract_events');
  const cancelledNotifyFailed = deliveryFailures.some(f => f.type === 'contract_cancelled');
  const finalClawWatermarks: Record<string, ClawWatermarkCursor> = { ...state.clawWatermarks };
  for (const clawId of Object.keys(nextClawWatermarks)) {
    const entries = processedEntries[clawId] ?? [];
    const prev = state.clawWatermarks[clawId] ?? fallbackCursor;
    let allowed: ClawWatermarkCursor | undefined;
    for (const e of entries) {
      const blockedByNotify =
        (e.status === 'completed' && completedNotifyFailed) ||
        (e.status === 'cancelled' && cancelledNotifyFailed);
      const blockedByRetro =
        retroBlockedCursor[clawId] !== undefined &&
        !isCursorGreater(retroBlockedCursor[clawId], e.cursor);
      if (blockedByNotify || blockedByRetro) break;
      allowed = e.cursor;
    }
    if (allowed && (!prev || isCursorGreater(allowed, prev))) {
      finalClawWatermarks[clawId] = allowed;
    }
  }
  // bootstrap tick 无投递：retro 水位与总水位对齐，不为部署前历史契约补发 retro。
  if (wasBootstrapPending) {
    for (const [clawId, cursor] of Object.entries(nextClawWatermarks)) {
      nextRetrospectiveWatermarks[clawId] = cursor;
    }
  }

  // phase 948/950: 任一投递成功（或 bootstrap 无投递 / 无事件）才写 state；
  // 总水位只推进到全消费者成功前缀；全部失败时沿用 phase 946 语义：抛错、不写 state，由 cron 重试。
  if (anyDeliverySucceeded || allDeliveriesSucceeded) {
    const newState: ObserverStateV7 = {
      version: STATE_SCHEMA_VERSION,
      lastCheckTs: tickStart,
      clawWatermarks: allDeliveriesSucceeded ? nextClawWatermarks : finalClawWatermarks,
      bootstrapDone: true,
      completedWatermarks: nextCompletedWatermarks,
      cancelledWatermarks: nextCancelledWatermarks,
      crashedWatermarks: state.crashedWatermarks,
      reportedCorrupted: state.reportedCorrupted,
      reportedActiveState: state.reportedActiveState,
      retrospectiveWatermarks: nextRetrospectiveWatermarks,
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
