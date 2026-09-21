import * as path from 'path';
import { formatErr } from "../../foundation/node-utils/index.js";
import { MOTION_CLAW_ID, type ClawTopology } from '../claw-topology/index.js';
import { isFileNotFound } from '../../foundation/fs/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import { MEMORY_AUDIT_EVENTS } from './audit-events.js';
import { MEMORY_DREAM_OUTPUTS_DIR } from './memory-paths.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { SubAgentTaskScheduler } from '../async-task-system/index.js';
import type { InboxMessageOptionsBase } from '../../foundation/messaging/index.js';
import type { ProgressData } from '../contract/index.js';
import type { ContractId } from '../contract/index.js';
import { type TaskId, type FullTaskId, type ShortTaskId, type TaskIdResolver } from '../async-task-system/index.js';
import { queryArchiveContracts, readArchiveProgress } from '../contract/index.js';
import type { ClawId } from '../../foundation/claw-identity/index.js';
import { assertDreamStateShape } from './invariants.js';
import { InboxReader, INBOX_PENDING_DIR, INBOX_DONE_DIR, INBOX_FAILED_DIR } from '../../foundation/messaging/index.js';

/**
 * Default pulse interval（ms）for waitForTaskResult polling.
 * Derivation: 30_000ms = 30s / 平衡 watcher event 收敛延迟 vs progress audit 频率;
 * 配套外层 subagentTimeoutMs（最长 1h）= 30 / pulse 共 ~120 ticks 上限.
 */
const DEFAULT_PULSE_INTERVAL_MS = 30_000;
import { auditRandomDreamCrossSource } from './dream-cross-source-audit.js';
import { loadDreamStateRaw, quarantineDreamStateRaw } from './dream-state-load.js';
import { dreamOutputsPersistedMessage } from '../../templates/messages/index.js';
import type { DreamStateDegraded } from './dream-state-load.js';
import {
  RANDOM_DREAM_SYSTEM_PROMPT,
  buildRandomDreamPrompt,
} from './prompts/random-dream.js';

/**
 * Default random-dream subagent execution timeout（ms）= 1 hour.
 * Derivation: 3600 * 1000 = 1hr / 给 dream subagent 足够时长完成探索性思考.
 */
const DEFAULT_RANDOM_DREAM_TIMEOUT_MS = 3600 * 1000;

/**
 * Default random-dream max step count（agent loop iteration cap）.
 * Derivation: 200 step ≈ 给 dream subagent 充分探索空间 / 比 DEFAULT_MAX_STEPS (1000) 紧 5×
 * 因 dream 任务相对局限 / 防 runaway loop OOM.
 */
const DEFAULT_RANDOM_DREAM_MAX_STEPS = 200;
/**
 * Random-dream late settle grace period（ms）= 7 days（phase 170 立）.
 * Derivation: 7 * 24 * 60 * 60_000 = 604_800_000 ms / 给 dream subagent 真超时后 settle 状态留
 * 长尾观察窗 / 7 天足够 cover 任何「task 实际完成但 settle 通知延迟」case / 之后视为永久放弃.
 */
const LATE_SETTLE_GRACE_MS = 7 * 24 * 60 * 60_000;

// ─── 类型定义 ────────────────────────────────────────────────

/** phase 92 / phase 1159 Step C: DI callback - caller (L6 装配期) bind chestnutRoot + MOTION_CLAW_ID + notifyClaw + fs + audit */
export type RandomDreamNotifyMotionFn = (message: InboxMessageOptionsBase) => Promise<void>;

export interface RandomDreamOptions {
  clawTopology: ClawTopology;
  motionDir: string;
  taskSystem: SubAgentTaskScheduler;
  fs: FileSystem;             // baseDir = chestnutRoot
  motionFs: FileSystem;       // baseDir = motionDir / NEW
  audit: AuditLog;
  /** Poll interval (ms) for waitForTaskResult / default 30_000 / phase 633 ⚓11 α */
  pulseIntervalMs?: number;
  /** Emit per-pulse audit RANDOM_DREAM_PULSE / default false（防 audit noise）/ phase 633 ⚓11 α */
  pulseAuditEnabled?: boolean;
  /** Subagent task timeout (ms) / default 1h / phase 651 */
  subagentTimeoutMs?: number;
  /** Subagent max steps / default 200 / phase 651 */
  subagentMaxSteps?: number;
  /** phase 92: caller-bound notify motion inbox */
  notifyMotion: RandomDreamNotifyMotionFn;
  signal?: AbortSignal;
  /** 读取指定 claw+contract 的 progress（M#3：不走直接文件访问） */
  getContractProgress?: (clawId: string, contractId: ContractId) => Promise<ProgressData | null>;
  /** phase 849: shortId ↔ fullId index for dual-key task IDs */
  shortIdIndex?: TaskIdResolver;
}

interface WeightedContract {
  clawId: string;
  contractId: ContractId;
  contractDir: string;
  weight: number;
  hint: string;
}

interface PendingLateSettleEntry {
  taskId: TaskId;
  fullTaskId?: FullTaskId;   // phase 849: stored fullId for persistence paths
  scheduledAt: number;       // ms epoch, entry entered pending
  expectedTimeoutAt: number; // scheduledAt + subagentTimeoutMs
  contractIds: ContractId[]; // phase 924/925: contracts covered by this pending task
}

/**
 * phase 548: 加 schema_version（与 phase 547 deep-dream 同模式 / sister 一致性）。
 * phase 1159 Step B: 升级到 v2，支持 pendingNotifications durable outbox。
 */
const RANDOM_DREAM_STATE_CURRENT_VERSION = 2;

interface PendingRandomDreamNotification {
  deliveryId: string;
  taskId: TaskId;
  outputPath: string;
  outputCount: number;
  completedContractIds: ContractId[];
  createdAt: number;
  lateSettleFullTaskId?: FullTaskId;
}

interface RandomDreamState {
  schema_version?: number;                              // phase 548: 显式 schema 版本（缺即视 v1）
  completedContractIds: ContractId[];                   // phase 925: per-contract 完成集合
  pendingLateSettle?: PendingLateSettleEntry[];         // phase 170: late-settle 待办（normalizeState 恒产出；optional 仅为容损坏输入，读侧校验过滤）
  pendingNotifications?: PendingRandomDreamNotification[]; // phase 1159 Step B: durable notification outbox
}

interface RandomDreamLoadResult {
  state: RandomDreamState;
  blocked?: { reason: string; version: number };
  /** phase 1810 Step B: malformed（已 quarantine）/ unavailable（未触文件）degraded 证据 */
  degraded?: DreamStateDegraded;
}

// ─── Random Dream State I/O ──────────────────────────────────

const RANDOM_DREAM_STATE_FILE = '.random-dream-state.json';

function isValidPendingEntry(e: unknown): e is PendingLateSettleEntry {
  if (typeof e !== 'object' || e === null) return false;
  const r = e as Record<string, unknown>;
  if (typeof r.taskId !== 'string') return false;
  if (typeof r.scheduledAt !== 'number') return false;
  if (typeof r.expectedTimeoutAt !== 'number') return false;
  if (!Array.isArray(r.contractIds)) return false;
  if (!r.contractIds.every((id: unknown) => typeof id === 'string')) return false;
  if (r.fullTaskId !== undefined && typeof r.fullTaskId !== 'string') return false;
  return true;
}

function isValidPendingNotification(e: unknown): e is PendingRandomDreamNotification {
  if (typeof e !== 'object' || e === null) return false;
  const r = e as Record<string, unknown>;
  if (typeof r.deliveryId !== 'string') return false;
  if (typeof r.taskId !== 'string') return false;
  if (typeof r.outputPath !== 'string') return false;
  if (typeof r.outputCount !== 'number' || !Number.isFinite(r.outputCount) || r.outputCount < 0) return false;
  if (!Array.isArray(r.completedContractIds)) return false;
  if (!r.completedContractIds.every((id: unknown) => typeof id === 'string')) return false;
  if (typeof r.createdAt !== 'number' || !Number.isFinite(r.createdAt)) return false;
  if (r.lateSettleFullTaskId !== undefined && typeof r.lateSettleFullTaskId !== 'string') return false;
  return true;
}

function normalizeState(r: Record<string, unknown>, audit: AuditLog): RandomDreamState {
  const pendingLateSettle = Array.isArray(r.pendingLateSettle)
    ? r.pendingLateSettle.filter(isValidPendingEntry)
    : [];
  if (Array.isArray(r.pendingLateSettle) && pendingLateSettle.length !== r.pendingLateSettle.length) {
    audit.write(MEMORY_AUDIT_EVENTS.RANDOM_DREAM_ERROR,
      `site=load_state`,
      `reason=pending_late_settle_entry_invalid_filtered`,
      `before=${r.pendingLateSettle.length}`,
      `after=${pendingLateSettle.length}`,
    );
  }

  const pendingNotifications = Array.isArray(r.pendingNotifications)
    ? r.pendingNotifications.filter(isValidPendingNotification)
    : [];
  if (Array.isArray(r.pendingNotifications) && pendingNotifications.length !== r.pendingNotifications.length) {
    audit.write(MEMORY_AUDIT_EVENTS.RANDOM_DREAM_ERROR,
      `site=load_state`,
      `reason=pending_notifications_entry_invalid_filtered`,
      `before=${r.pendingNotifications.length}`,
      `after=${pendingNotifications.length}`,
    );
  }

  return {
    schema_version: RANDOM_DREAM_STATE_CURRENT_VERSION,
    completedContractIds: Array.isArray(r.completedContractIds)
      ? r.completedContractIds.filter((v): v is ContractId => typeof v === 'string')
      : [],
    pendingLateSettle,
    pendingNotifications,
  };
}

function defaultRandomDreamState(): RandomDreamState {
  return { schema_version: RANDOM_DREAM_STATE_CURRENT_VERSION, completedContractIds: [] };
}

function loadRandomDreamState(fs: FileSystem, audit: AuditLog): RandomDreamLoadResult {
  // phase 1810 Step B: typed 四态 load（与 deep-dream 共用 owner policy，不复制逻辑）
  const loaded = loadDreamStateRaw(fs, RANDOM_DREAM_STATE_FILE);
  switch (loaded.kind) {
    case 'absent':
      // FileNotFoundError 首启良性 / silent
      return { state: defaultRandomDreamState() };
    case 'unavailable':
      // IO 故障（EACCES 等）不隐式转 default：不读不写、不 quarantine，degraded 保留证据
      audit.write(MEMORY_AUDIT_EVENTS.RANDOM_DREAM_ERROR,
        `site=load_state`,
        `cause=unavailable`,
        `reason=${loaded.error}`,
      );
      return { state: defaultRandomDreamState(), degraded: { cause: 'unavailable', error: loaded.error } };
    case 'malformed': {
      // 损坏 state：先原子 quarantine raw（唯一后缀、不覆盖旧 raw），证据先于任何 reset；
      // quarantine 失败原文件不动，绝不因隔离失败而覆盖原始 state。
      const quarantine = quarantineDreamStateRaw(fs, RANDOM_DREAM_STATE_FILE);
      audit.write(MEMORY_AUDIT_EVENTS.RANDOM_DREAM_ERROR,
        `site=load_state`,
        `cause=malformed`,
        `reason=${loaded.error}`,
        quarantine.kind === 'quarantined'
          ? `quarantine=${quarantine.path}`
          : `quarantine=failed:${quarantine.error}`,
      );
      return {
        state: defaultRandomDreamState(),
        degraded: { cause: 'malformed', error: loaded.error, quarantine },
      };
    }
    case 'found': {
      const r = loaded.raw;

    // phase 927: reject future schema versions (keep file, return blocked)
    const version = typeof r.schema_version === 'number' ? r.schema_version : 0;
    if (version > RANDOM_DREAM_STATE_CURRENT_VERSION) {
      audit.write(MEMORY_AUDIT_EVENTS.DREAM_STATE_FUTURE_VERSION,
        `version=${version}`,
        `current=${RANDOM_DREAM_STATE_CURRENT_VERSION}`,
        `reason=cannot_migrate_future_version`,
      );
      return {
        state: { schema_version: RANDOM_DREAM_STATE_CURRENT_VERSION, completedContractIds: [] },
        blocked: { reason: 'future_schema', version },
      };
    }

    // phase 280/925: legacy schema migration
    if ('processedContractIds' in r || 'lastProcessedRandomDreamAt' in r) {
      const legacyField = 'processedContractIds' in r ? 'processedContractIds' : 'lastProcessedRandomDreamAt';
      audit.write(MEMORY_AUDIT_EVENTS.LEGACY_SCHEMA_MIGRATED_RESET,
        `kind=random_dream`,
        `legacy_field=${legacyField}`,
        `legacy_count=${Array.isArray(r.processedContractIds) ? r.processedContractIds.length : 0}`,
      );
      const normalized = normalizeState(r, audit);
      // phase 925: best-effort seed completedContractIds from legacy processedContractIds
      const completed: ContractId[] = Array.isArray(r.processedContractIds)
        ? r.processedContractIds.filter((id): id is ContractId => typeof id === 'string')
        : [];
      return { state: { ...normalized, completedContractIds: completed } };
    }

    return { state: normalizeState(r, audit) };
    }
  }
}

function saveRandomDreamState(
  fs: FileSystem,
  state: RandomDreamState,
  audit: AuditLog,
): void {
  // phase 247 Step A: schema invariant
  assertDreamStateShape(state, audit, 'random_dream_save');

  // phase 280: internal self-consistency audit（RC-2/RC-3）
  auditRandomDreamCrossSource(state, audit);

  try {
    // phase 548 / phase 1159 Step B: 总写 schema_version；确保当前版本最终生效
    const stateToSave = { ...state, schema_version: RANDOM_DREAM_STATE_CURRENT_VERSION };
    fs.writeAtomicSync(
      RANDOM_DREAM_STATE_FILE,
      JSON.stringify(stateToSave, null, 2)
    );
  } catch (err) {
    audit.write(MEMORY_AUDIT_EVENTS.RANDOM_DREAM_ERROR,
      `site=save_state`,
      `reason=${formatErr(err)}`,
    );
    throw err;   // re-throw 保 caller flow（cron runner phase 552 late_error 路径捕获）
  }
}

// ─── 契约发现与权重计算 ──────────────────────────────────────



/** 计算契约权重（越高越优先） */
type SubtaskInfo = ProgressData['subtasks'][string];

function calculateWeightFactors(
  subtasks: SubtaskInfo[],
): { recencyBonus: number; difficultyBonus: number; hints: string[] } {
  const hints: string[] = [];

  // 近期完成加权（7 天内权重最高）
  const completedAts = subtasks
    .map(s => s.completed_at ? new Date(s.completed_at).getTime() : 0)
    .filter(t => t > 0);
  let recencyBonus = 0;
  if (completedAts.length > 0) {
    const latestMs = Math.max(...completedAts);
    const daysAgo = (Date.now() - latestMs) / (1000 * 60 * 60 * 24);
    recencyBonus = Math.round(50 * Math.exp(-daysAgo / 7));
    if (recencyBonus > 20) hints.push('近期完成');
  }

  // 失败/困难加权（phase 1405: force_accepted = system 强接受 = 难点信号）
  let difficultyBonus = 0;
  for (const s of subtasks) {
    if (s.force_accepted === true) difficultyBonus += 20;
    else if ((s.retry_count ?? 0) >= 2) difficultyBonus += 10;
  }
  if (difficultyBonus > 0) hints.push('执行困难');

  return { recencyBonus, difficultyBonus, hints };
}

async function computeWeight(
  fs: FileSystem,
  contractId: ContractId,
  contractDir: string,
  clawId: string,
  clawsSeen: Set<string>,     // 本次已选中的 clawId 集合
  audit: AuditLog,
  getContractProgress?: (clawId: string, contractId: ContractId) => Promise<ProgressData | null>,
): Promise<{ weight: number; hint: string }> {
  let weight = 10;
  const hints: string[] = [];

  // 不同 claw 优先
  if (!clawsSeen.has(clawId)) {
    weight += 30;
    hints.push('新claw');
  }

  // 近期完成：读 progress 中各 subtask 的 completed_at
  // M#3：优先走 ContractSystem 公开 API；fallback 直接文件访问（兼容未注入场景）
  if (getContractProgress) {
    try {
      const progress = await getContractProgress(clawId, contractId);
      if (!progress) {
        throw new Error('progress unavailable (schema corruption)');
      }
      const subtasks = Object.values(progress.subtasks ?? {});
      const factors = calculateWeightFactors(subtasks);
      weight += factors.recencyBonus + factors.difficultyBonus;
      hints.push(...factors.hints);
    } catch (e) {
      audit.write(MEMORY_AUDIT_EVENTS.RANDOM_DREAM_ERROR,
        `site=getContractProgress_api`,
        `clawId=${clawId}`,
        `contractId=${contractId}`,
        `reason=${formatErr(e)}`);
      // best-effort：API 失败、跳过 recency/difficulty 加权
    }
  } else {
    // fallback：通过轻量 API 读 progress.json（backward compatible / 未注入 ContractSystem 时）
    try {
      const raw = readArchiveProgress(fs, { contractDir });
      if (!raw || typeof raw.subtasks !== 'object') {
        audit.write(MEMORY_AUDIT_EVENTS.RANDOM_DREAM_ERROR,
          'site=load_progress', 'reason=shape_mismatch', `got=${typeof raw}`);
        return { weight, hint: hints.join('、') || '正常' };
      }
      const progress = raw as unknown as ProgressData;
      const subtasks = Object.values(progress.subtasks ?? {});
      const factors = calculateWeightFactors(subtasks);
      weight += factors.recencyBonus + factors.difficultyBonus;
      hints.push(...factors.hints);
    } catch (e) {
      // ENOENT 是预期（contract 无 progress.json 是正常初态）— 仅非 ENOENT 必 audit
      if (!isFileNotFound(e)) {
        audit.write(MEMORY_AUDIT_EVENTS.RANDOM_DREAM_ERROR,
          `site=load_progress_fallback`,
          `contractDir=${contractDir}`,
          `reason=${formatErr(e)}`);
      }
    }
  }

  // 权重下限 1
  weight = Math.max(1, weight);
  return { weight, hint: hints.join('、') || '正常' };
}

async function discoverWeightedContracts(
  fs: FileSystem,
  clawTopology: ClawTopology,
  state: RandomDreamState,
  audit: AuditLog,
  getContractProgress?: (clawId: string, contractId: ContractId) => Promise<ProgressData | null>,
): Promise<WeightedContract[]> {
  const clawsSeen = new Set<string>();
  const contracts: WeightedContract[] = [];

  // Phase 1370 Step C: RandomDream own「排除 motion 后跨普通 claw 选样」的 universe；
  // ClawTopology own enumerate/resolve；ContractSystem only 查询 caller 指定的 archive root。
  // phase 925: 不再使用单一高水位线过滤；改为按 completed/pending contractIds 集合过滤
    let clawIds: ClawId[];
  try {
    clawIds = clawTopology.enumerate().filter(id => id !== MOTION_CLAW_ID);
  } catch (err) {
    // claws/ 不存在 = 首启良性空 universe（test「claws 目录不存在时直接返回」锁定）
    if (isFileNotFound(err)) return [];
    audit.write(MEMORY_AUDIT_EVENTS.RANDOM_DREAM_ERROR,
      `site=archive_query_enumerate`,
      `reason=${formatErr(err)}`);
    throw err;
  }

    const archiveResult = await queryArchiveContracts({ fs, clawTopology, clawIds });

  // 每条 structured issue 逐条 audit；incomplete=true 不丢 entries
  for (const issue of archiveResult.issues) {
    audit.write(MEMORY_AUDIT_EVENTS.RANDOM_DREAM_ERROR,
      `site=archive_query`,
      `code=${issue.code}`,
      ...(issue.clawId !== undefined ? [`clawId=${issue.clawId}`] : []),
      ...(issue.contractId !== undefined ? [`contractId=${issue.contractId}`] : []),
      ...(issue.detail !== undefined ? [`detail=${issue.detail}`] : []),
      ...(issue.cause !== undefined ? [`cause=${formatErr(issue.cause)}`] : []),
    );
  }

  // phase 925: exclude contracts already completed or covered by pending late-settle tasks
  const completedIds = new Set<ContractId>(state.completedContractIds);
  const pendingIds = new Set<ContractId>(
    (state.pendingLateSettle ?? [])
      .flatMap(e => e.contractIds)
  );
  const visibleRefs = archiveResult.entries.filter(ref =>
    !completedIds.has(ref.contractId) && !pendingIds.has(ref.contractId)
  );

  for (const ref of visibleRefs) {
    const { clawId, contractId, contractDir } = ref;
    const { weight, hint } = await computeWeight(fs, contractId, contractDir, clawId, clawsSeen, audit, getContractProgress);
    contracts.push({ clawId, contractId, contractDir, weight, hint });
    clawsSeen.add(clawId);  // NEW phase 585 / 每 claw 首契约获 +30 bonus / 后续不获
  }

  // 按权重降序排序
  contracts.sort((a, b) => b.weight - a.weight);

  // 标记每个 claw 首次出现（用于 prompt 的 hint 显示）
  const firstSeenClaws = new Set<string>();
  for (const c of contracts) {
    if (!firstSeenClaws.has(c.clawId)) {
      firstSeenClaws.add(c.clawId);
      // 首次出现的 claw 保留 hint（如"新claw"）
    } else {
      // 同一 claw 的后续契约，hint 去掉"新claw"标记
      c.hint = c.hint.replace(/^新claw、?|、?新claw/, '') || '正常';
    }
  }

  return contracts;
}

// phase 849: resolve shortId → fullId when available; fall back to shortId if no index.
function resolveFullTaskId(
  shortId: ShortTaskId,
  index?: TaskIdResolver,
): FullTaskId | undefined {
  return index?.resolve(shortId);
}

// ─── 等待任务结果 ────────────────────────────────────────────

export async function waitForTaskResult(
  motionFs: FileSystem,
  taskId: TaskId,
  timeoutMs: number,
  pollIntervalMs = 30_000,
  audit?: AuditLog,
  auditEnabled = false,
  signal?: AbortSignal,
): Promise<string | null> {
  // .txt 由 AsyncTaskSystem.sendResult 在 subAgent.run() 完成后写入，是可靠的完成信号
  const donePath = path.join('tasks', 'queues', 'results', taskId, 'result.txt');
  // [DREAM_OUTPUT] 块由 appendToLog 写入 .log
  const logPath  = path.join('tasks', 'queues', 'results', taskId, 'daemon.log');
  const deadline = Date.now() + timeoutMs;
  let pulseCount = 0;

  while (Date.now() < deadline) {
    if (signal?.aborted) {
      audit?.write(MEMORY_AUDIT_EVENTS.RANDOM_DREAM_WARNING, `reason=aborted`, `taskId=${taskId}`);
      return null;
    }
    if (motionFs.existsSync(donePath)) {
      // 完成信号出现，读取日志内容
      if (motionFs.existsSync(logPath)) {
        try {
          return motionFs.readSync(logPath);
        } catch (e) {
          if (isFileNotFound(e)) {
            // TOCTOU: log was deleted between existsSync and readSync
            // fall through to .txt
          } else {
            throw e; // real I/O error — let caller decide
          }
        }
      }
      // .log 不存在（极端情况），降级读 .txt
      try {
        return motionFs.readSync(donePath);
      } catch (e) {
        if (isFileNotFound(e)) {
          // TOCTOU: done file vanished — re-enter poll loop
        } else {
          throw e; // real I/O error
        }
      }
    }
    if (auditEnabled && audit) {
      audit.write(
        MEMORY_AUDIT_EVENTS.RANDOM_DREAM_PULSE,
        `taskId=${taskId}`,
        `pulse=${pulseCount}`,
        `interval_ms=${pollIntervalMs}`,
      );
    }
    pulseCount++;
    await new Promise(r => setTimeout(r, pollIntervalMs));
  }

  audit?.write(MEMORY_AUDIT_EVENTS.RANDOM_DREAM_WAIT_TIMEOUT, `reason=poll_timeout`, `taskId=${taskId}`);
  return null;
}

// ─── 结果解析 ────────────────────────────────────────────────

interface DreamExtractionResult {
  outputs: string[];
  contractIds: string[];
}

// phase 1467: export-for-test (F9 from audit-2026-05-30) / API surface unchanged for production
/** @internal test-only export (phase 1467) */
export function __test_extractDreamOutputs(log: string): DreamExtractionResult {
  return extractDreamOutputs(log);
}

// phase 247: export-for-test
/** @internal test-only export (phase 247) */
export const __test_saveRandomDreamState = saveRandomDreamState;
/** @internal test-only export (phase 247) */
export const __test_RANDOM_DREAM_STATE_FILE = RANDOM_DREAM_STATE_FILE;
/** @internal test-only export (phase 280) */
export const __test_loadRandomDreamState = loadRandomDreamState;
export type { RandomDreamState as __test_RandomDreamState };

/** 从 sub-agent log 中提取 [DREAM_OUTPUT contract_id="..."]...[/DREAM_OUTPUT] 块 */
function extractDreamOutputs(log: string): DreamExtractionResult {
  const outputs: string[] = [];
  const contractIds: string[] = [];

  // 匹配 [DREAM_OUTPUT contract_id="contractId"]...内容...[/DREAM_OUTPUT]
  const re = /\[DREAM_OUTPUT\s+contract_id="([^"]+)"\]([\s\S]*?)\[\/DREAM_OUTPUT\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(log)) !== null) {
    contractIds.push(match[1]);
    outputs.push(match[2].trim());
  }

  return { outputs, contractIds };
}

// ─── durable completion notification outbox ──────────────────

const DELIVERY_META_KEY = 'delivery_id';
const DONE_DEDUP_WINDOW_MS = Number.POSITIVE_INFINITY;

function makeDeliveryId(taskId: TaskId, fullTaskId?: FullTaskId): string {
  return `random-dream:${fullTaskId ?? taskId}`;
}

interface BuildPendingNotificationParams {
  taskId: TaskId;
  fullTaskId?: FullTaskId;
  outputPath: string;
  outputCount: number;
  completedContractIds: ContractId[];
}

function buildPendingNotification(params: BuildPendingNotificationParams): PendingRandomDreamNotification {
  return {
    deliveryId: makeDeliveryId(params.taskId, params.fullTaskId),
    taskId: params.taskId,
    outputPath: params.outputPath,
    outputCount: params.outputCount,
    completedContractIds: [...new Set(params.completedContractIds)],
    createdAt: Date.now(),
    ...(params.fullTaskId ? { lateSettleFullTaskId: params.fullTaskId } : {}),
  };
}

function toCompletionMessage(item: PendingRandomDreamNotification): InboxMessageOptionsBase {
  return {
    type: 'random_dream_completed',
    source: 'random-dream',
    priority: 'normal',
    body: dreamOutputsPersistedMessage({
      taskId: item.taskId,
      outputCount: item.outputCount,
      outputPath: item.outputPath,
    }),
    metadata: {
      dreamId: item.taskId,
      outputCount: String(item.outputCount),
      path: item.outputPath,
      ...(item.lateSettleFullTaskId ? { lateSettleFullTaskId: item.lateSettleFullTaskId } : {}),
    },
    extraFields: { [DELIVERY_META_KEY]: item.deliveryId },
  };
}

function stageCompletedDream(
  state: RandomDreamState,
  pendingTaskId: TaskId,
  item: PendingRandomDreamNotification,
): RandomDreamState {
  return {
    ...state,
    pendingLateSettle: (state.pendingLateSettle ?? [])
      .filter(entry => entry.taskId !== pendingTaskId),
    completedContractIds: [...new Set([
      ...state.completedContractIds, ...item.completedContractIds,
    ])],
    pendingNotifications: [
      ...(state.pendingNotifications ?? []).filter(
        old => old.deliveryId !== item.deliveryId,
      ),
      item,
    ],
  };
}

async function flushPendingNotifications(
  opts: RandomDreamOptions,
  state: RandomDreamState,
): Promise<RandomDreamState> {
  const reader = new InboxReader(
    INBOX_PENDING_DIR, INBOX_DONE_DIR, INBOX_FAILED_DIR,
    opts.motionFs, opts.audit,
  );
  let current = state;
  for (const item of current.pendingNotifications ?? []) {
    const existing = await reader.findByExtraMeta(
      DELIVERY_META_KEY,
      item.deliveryId,
      { includeDoneWithinMs: DONE_DEDUP_WINDOW_MS },
    );
    if (!existing) {
      await opts.notifyMotion(toCompletionMessage(item));
    }
    current = {
      ...current,
      pendingNotifications: current.pendingNotifications?.filter(
        candidate => candidate.deliveryId !== item.deliveryId,
      ),
    };
    saveRandomDreamState(opts.fs, current, opts.audit);
  }
  return current;
}

// ─── sweep late-settle pending ───────────────────────────────

async function sweepLateSettlePending(
  opts: RandomDreamOptions,
  state: RandomDreamState,
): Promise<RandomDreamState> {
  const pending = state.pendingLateSettle ?? [];
  if (pending.length === 0) return state;

  const now = Date.now();
  let current = state;
  let dropped = false;

  for (const entry of pending) {
    const lateFullId = entry.fullTaskId
      ?? (entry.taskId.length === 36 ? entry.taskId as FullTaskId : resolveFullTaskId(entry.taskId as ShortTaskId, opts.shortIdIndex));
    const lateTaskIdForPaths = lateFullId ?? entry.taskId;
    const donePath = path.join('tasks', 'queues', 'results', lateTaskIdForPaths, 'result.txt');
    const logPath  = path.join('tasks', 'queues', 'results', lateTaskIdForPaths, 'daemon.log');

    if (opts.motionFs.existsSync(donePath)) {
      // settled — consume
      const log = opts.motionFs.existsSync(logPath)
        ? opts.motionFs.readSync(logPath)
        : opts.motionFs.readSync(donePath);

      const { outputs, contractIds } = extractDreamOutputs(log);
      if (outputs.length > 0) {
        const dreamOutput = outputs.join('\n\n---\n\n');
        const dreamOutputPath = `${MEMORY_DREAM_OUTPUTS_DIR}/${lateTaskIdForPaths}.txt`;
        await opts.motionFs.ensureDir(MEMORY_DREAM_OUTPUTS_DIR);
        await opts.motionFs.writeAtomic(dreamOutputPath, dreamOutput);

        opts.audit.write(
          MEMORY_AUDIT_EVENTS.DREAM_OUTPUT_PERSISTED,
          `dreamId=${entry.taskId}`,
          `path=${dreamOutputPath}`,
          `bytes=${dreamOutput.length}`,
        );

        // phase 1159 Step D: durable delivery — stage outbox + send + confirm
        const notification = buildPendingNotification({
          taskId: entry.taskId,
          fullTaskId: lateFullId,
          outputPath: dreamOutputPath,
          outputCount: outputs.length,
          completedContractIds: contractIds as ContractId[],
        });
        current = stageCompletedDream(current, entry.taskId, notification);
        saveRandomDreamState(opts.fs, current, opts.audit);
        current = await flushPendingNotifications(opts, current);
      } else {
        // settled but no output — drop entry
        current = {
          ...current,
          pendingLateSettle: current.pendingLateSettle?.filter(p => p.taskId !== entry.taskId),
        };
        dropped = true;
      }

      opts.audit.write(
        MEMORY_AUDIT_EVENTS.RANDOM_DREAM_LATE_SETTLE_CONSUMED,
        `taskId=${entry.taskId}`,
        `output_count=${outputs.length}`,
        `latency_ms=${now - entry.scheduledAt}`,
      );
      continue;  // entry drop
    }

    // not settled — grace check
    if (now - entry.scheduledAt > LATE_SETTLE_GRACE_MS) {
      opts.audit.write(
        MEMORY_AUDIT_EVENTS.RANDOM_DREAM_LATE_SETTLE_ABANDONED,
        `taskId=${entry.taskId}`,
        `age_ms=${now - entry.scheduledAt}`,
        `grace_ms=${LATE_SETTLE_GRACE_MS}`,
      );
      current = {
        ...current,
        pendingLateSettle: current.pendingLateSettle?.filter(p => p.taskId !== entry.taskId),
      };
      dropped = true;
      continue;  // entry drop
    }

    // still pending、保
  }

  if (dropped) {
    saveRandomDreamState(opts.fs, current, opts.audit);
  }
  return current;
}

// ─── 主函数 ──────────────────────────────────────────────────

/**
 * Run one random-dream pulse (cron-driven).
 *
 * Design intent (per phase 622 ratify ⚓11 = α / l4_memory_system §B.random-dream-pulse-strategy):
 * - 4 audit per invocation (step=skip_empty / scheduled / subagent_started / finished)
 * - opts.pulseIntervalMs (default 30_000) controls inner poll interval in waitForTaskResult
 * - opts.pulseAuditEnabled (default false) opt-in per-pulse audit RANDOM_DREAM_PULSE
 * - β fs.watch + γ exponential backoff rejected per phase 622 28 原则核（D5+caller-control+YAGNI dominant）
 */
export async function runRandomDream(opts: RandomDreamOptions): Promise<void> {
  const loaded = loadRandomDreamState(opts.fs, opts.audit);
  if (loaded.degraded) {
    // phase 1810 Step B: 损坏/不可用 state 阻断本轮 pulse——不 schedule、不 save，
    // 新 canonical state 只能由下一轮 absent 路径在证据保全后建立（显式 reset gate）。
    opts.audit.write(MEMORY_AUDIT_EVENTS.RANDOM_DREAM_JOB, `step=blocked`, `reason=state_${loaded.degraded.cause}`);
    return;
  }
  if (loaded.blocked) {
    opts.audit.write(MEMORY_AUDIT_EVENTS.RANDOM_DREAM_JOB, `step=blocked`, `reason=${loaded.blocked.reason}`);
    return;
  }
  let state = loaded.state;
  state = await flushPendingNotifications(opts, state);   // phase 1159 Step D: recover prior crash
  state = await sweepLateSettlePending(opts, state);   // NEW phase 170
  const weightedContracts = await discoverWeightedContracts(
    opts.fs,
    opts.clawTopology,
    state,
    opts.audit,
    opts.getContractProgress,
  );

  if (weightedContracts.length === 0) {
    opts.audit.write(MEMORY_AUDIT_EVENTS.RANDOM_DREAM_JOB, `step=skip_empty`);
    return;
  }

  opts.audit.write(MEMORY_AUDIT_EVENTS.RANDOM_DREAM_JOB, `step=scheduled`, `count=${weightedContracts.length}`);

  // 调度 sub-agent（文件驱动，watcher 异步拾起）
  const subagentTimeoutMs = opts.subagentTimeoutMs ?? DEFAULT_RANDOM_DREAM_TIMEOUT_MS;
  const subagentMaxSteps = opts.subagentMaxSteps ?? DEFAULT_RANDOM_DREAM_MAX_STEPS;

    // phase 1863 (AT-D11)：scheduler 契约返回 ShortTaskId
    const taskId = await opts.taskSystem.schedule('subagent', {
    kind: 'subagent',
    mode: 'standard',
    intent: buildRandomDreamPrompt(weightedContracts),
    timeoutMs: subagentTimeoutMs,
    maxSteps: subagentMaxSteps,
    parentClawId: MOTION_CLAW_ID,
    originClawId: MOTION_CLAW_ID,
    toolProfile: 'subagent',
    systemPrompt: RANDOM_DREAM_SYSTEM_PROMPT,    // phase 546: dead import 活化（同 deep-dream 直 LLMService.call 模板 align）
  });
  const fullTaskId = resolveFullTaskId(taskId, opts.shortIdIndex);
  const taskIdForPaths = fullTaskId ?? taskId;

  opts.audit.write(MEMORY_AUDIT_EVENTS.RANDOM_DREAM_JOB, `step=subagent_started`, `taskId=${taskId}`);

  // phase 925: persist pending contractIds immediately after schedule (crash-recoverable)
  const now = Date.now();
  const pendingEntry: PendingLateSettleEntry = {
    taskId,
    ...(fullTaskId ? { fullTaskId } : {}),
    scheduledAt: now,
    expectedTimeoutAt: now + subagentTimeoutMs,
    contractIds: weightedContracts.map(wc => wc.contractId),
  };
  state.pendingLateSettle = [...(state.pendingLateSettle ?? []), pendingEntry];
  saveRandomDreamState(opts.fs, state, opts.audit);

  // 等待完成（最长 1h，每 30s 轮询）
    const log = await waitForTaskResult(
    opts.motionFs,
    taskIdForPaths,
    subagentTimeoutMs,
    opts.pulseIntervalMs ?? DEFAULT_PULSE_INTERVAL_MS,
    opts.audit,
    opts.pulseAuditEnabled ?? false,
    opts.signal,
  );
  if (!log) {
    // pending entry already persisted above; just emit audits
    opts.audit.write(
      MEMORY_AUDIT_EVENTS.RANDOM_DREAM_LATE_SETTLE_PENDING,
      `taskId=${taskId}`,
      `expected_timeout_at=${now + subagentTimeoutMs}`,
    );
    opts.audit.write(
      MEMORY_AUDIT_EVENTS.RANDOM_DREAM_SUBAGENT_TIMEOUT,
      `reason=subagent_timeout`,
      `taskId=${taskId}`,  // NEW phase 758 / 让事后 grep result.txt 关联
    );
    return;
  }

  // 解析梦境输出
  const { outputs, contractIds: completedIds } = extractDreamOutputs(log);
  if (outputs.length === 0) {
    // phase 925: remove pending entry even when no output, then save state
    state.pendingLateSettle = state.pendingLateSettle?.filter(p => p.taskId !== taskId);
    saveRandomDreamState(opts.fs, state, opts.audit);
    opts.audit.write(MEMORY_AUDIT_EVENTS.RANDOM_DREAM_OUTPUT_MISSING, `reason=no_output`);
    return;
  }

  opts.audit.write(MEMORY_AUDIT_EVENTS.RANDOM_DREAM_JOB, `step=finished`, `output_count=${outputs.length}`);

  const completedSet = new Set(completedIds);
  const newlyCompletedIds = weightedContracts
    .filter(wc => completedSet.has(wc.contractId))
    .map(wc => wc.contractId);

  const dreamOutput = outputs.join('\n\n---\n\n');
  const dreamOutputPath = `${MEMORY_DREAM_OUTPUTS_DIR}/${taskIdForPaths}.txt`;

  // phase 924/925: 先写 output snapshot
  await opts.motionFs.ensureDir(MEMORY_DREAM_OUTPUTS_DIR);
  await opts.motionFs.writeAtomic(dreamOutputPath, dreamOutput);
  opts.audit.write(
    MEMORY_AUDIT_EVENTS.DREAM_OUTPUT_PERSISTED,
    `dreamId=${taskId}`,
    `path=${dreamOutputPath}`,
    `bytes=${dreamOutput.length}`,
  );

  // phase 1159 Step D: durable delivery — stage outbox, commit state, then flush
  const notification = buildPendingNotification({
    taskId,
    fullTaskId,
    outputPath: dreamOutputPath,
    outputCount: outputs.length,
    completedContractIds: newlyCompletedIds,
  });
  state = stageCompletedDream(state, taskId, notification);
  saveRandomDreamState(opts.fs, state, opts.audit);
  state = await flushPendingNotifications(opts, state);
}
