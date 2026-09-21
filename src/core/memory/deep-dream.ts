import { formatErr, sha256ShortHex } from "../../foundation/node-utils/index.js";
import type { FileSystem } from '../../foundation/fs/index.js';
import { MEMORY_AUDIT_EVENTS } from './audit-events.js';
import { MEMORY_DREAM_OUTPUTS_DIR } from './memory-paths.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { LLMOrchestrator } from '../../foundation/llm-orchestrator/index.js';
import type { LLMOrchestratorConfig } from '../../foundation/llm-orchestrator/index.js';
import type { ContentBlock, TextBlock, LLMResponse } from '../../foundation/llm-provider/index.js';
import type { Message } from '../../foundation/dialog-store/index.js';
import { InboxReader, INBOX_PENDING_DIR, INBOX_DONE_DIR, INBOX_FAILED_DIR } from '../../foundation/messaging/index.js';
import type { InboxMessageOptionsBase } from '../../foundation/messaging/index.js';
import { estimateTextTokens } from '../../foundation/llm-provider/index.js';

import { DialogStore, DIALOG_DIR, CURRENT_DIALOG_FILE, DialogIOError } from '../../foundation/dialog-store/index.js';
import type { SessionData } from '../../foundation/dialog-store/index.js';
import { CLAWS_DIR } from '../../foundation/claw-identity/index.js';

import { MOTION_CLAW_ID } from '../claw-topology/index.js';
import type { ClawTopology } from '../../core/claw-topology/index.js';
import { assertDreamStateShape } from './invariants.js';
import { auditDeepDreamCrossSource } from './dream-cross-source-audit.js';
import { loadDreamStateRaw, quarantineDreamStateRaw } from './dream-state-load.js';
import type { DreamStateDegraded } from './dream-state-load.js';

/**
 * Default max tokens for memory compression pass（deep-dream LLM call 上限）.
 * Derivation: 4000 token ≈ 3000 中文字 / 配 COMPRESSION_TARGET_MAX_CHARS=500 内嵌 prompt budget /
 * 留余给 reasoning + JSON output structure / 比 SUBAGENT 默认低因 dream 任务限定明确.
 */
const COMPRESSION_TOKENS_DEFAULT = 4000;
import {
  DEEP_DREAM_SYSTEM_PROMPT,
  buildDreamInput,
  COMPRESSION_PROMPT,
  META_COMPRESSION_PROMPT,
} from './prompts/deep-dream.js';

// ─── 类型定义 ───────────────────────────────────────────────

/**
 * phase 547: 加 schema_version 字段（DP「持久化 schema 显式版本」+ 与 contract/progress.json / dialog/current.json 同模式）。
 * phase 1162 Step B: 升级到 v2，支持 pendingNotifications durable outbox。
 * v1/v2 = 历史 schema；未来增/改字段时 ++version + 加 migration 路径。
 */
const DEEP_DREAM_STATE_CURRENT_VERSION = 2;

interface PendingDeepDreamNotification {
  deliveryId: string;
  body: string;
  sessionCount: number;
  createdAt: number;
}

interface DreamStateData {
  schema_version?: number;               // phase 547: 显式 schema 版本（默认 1、未写也视 v1）
  lastProcessedDeepDreamAt: number;      // ms epoch 高水位线：archivedAt ≤ 此值的视为已处理
  currentSessionDreamedDate: string;     // "YYYY-MM-DD"，当日 current.json 已处理
  currentSessionRetryCount?: number;     // Phase 1200: current.json 损坏重试计数器
  pendingNotifications?: PendingDeepDreamNotification[];  // phase 1162 Step B: durable notification outbox
}

// Phase 1161: discriminated load result so callers can stop before discovery/LLM/output/save.
// phase 1810 Step B: 新增 degraded——malformed（quarantine 证据）/ unavailable（未触文件），
// 均不得隐式转 ready/default，caller 阻断本轮 run（不 save 覆盖原始 state）。
type DeepDreamStateLoadResult =
  | { status: 'ready'; state: DreamStateData }
  | { status: 'blocked'; reason: 'future_schema'; version: number }
  | { status: 'degraded'; degraded: DreamStateDegraded };

function defaultDreamState(): DreamStateData {
  return {
    schema_version: DEEP_DREAM_STATE_CURRENT_VERSION,
    lastProcessedDeepDreamAt: 0,
    currentSessionDreamedDate: '',
    currentSessionRetryCount: 0,
    pendingNotifications: [],
  };
}

function isValidPendingDeepNotification(e: unknown): e is PendingDeepDreamNotification {
  if (typeof e !== 'object' || e === null) return false;
  const n = e as Record<string, unknown>;
  if (typeof n.deliveryId !== 'string') return false;
  if (typeof n.body !== 'string') return false;
  if (typeof n.sessionCount !== 'number' || !Number.isFinite(n.sessionCount) || n.sessionCount < 0) return false;
  if (typeof n.createdAt !== 'number' || !Number.isFinite(n.createdAt)) return false;
  return true;
}

function normalizeDreamState(raw: Record<string, unknown>, audit: AuditLog, clawId: string): DreamStateData {
  const pendingNotifications = Array.isArray(raw.pendingNotifications)
    ? raw.pendingNotifications.filter(isValidPendingDeepNotification)
    : [];
  if (Array.isArray(raw.pendingNotifications)
      && pendingNotifications.length !== raw.pendingNotifications.length) {
    audit.write(MEMORY_AUDIT_EVENTS.DEEP_DREAM_ERROR,
      'step=load_state',
      `clawId=${clawId}`,
      'reason=pending_notifications_entry_invalid_filtered',
      `before=${raw.pendingNotifications.length}`,
      `after=${pendingNotifications.length}`);
  }
  return {
    schema_version: DEEP_DREAM_STATE_CURRENT_VERSION,
    lastProcessedDeepDreamAt: typeof raw.lastProcessedDeepDreamAt === 'number'
      ? raw.lastProcessedDeepDreamAt : 0,
    currentSessionDreamedDate: typeof raw.currentSessionDreamedDate === 'string'
      ? raw.currentSessionDreamedDate : '',
    ...(typeof raw.currentSessionRetryCount === 'number'
      ? { currentSessionRetryCount: raw.currentSessionRetryCount } : {}),
    pendingNotifications,
  };
}

function ready(state: DreamStateData): DeepDreamStateLoadResult {
  return { status: 'ready', state };
}

/** phase 1162 Step C: DI callback - caller (L6 装配期) bind chestnutRoot + MOTION_CLAW_ID + notifyClaw + fs + audit */
export type DeepDreamNotifyClawFn = (
  clawId: string,
  message: InboxMessageOptionsBase,
) => Promise<void>;

export interface DeepDreamOptions {
  /** phase 259: caller (装配期) 注入的 claw topology */
  clawTopology: ClawTopology;
  motionDir?: string;                    // motion 域 / dream-outputs 归属
  motionFs?: FileSystem;                 // baseDir = motionDir
  llmConfig: LLMOrchestratorConfig;
  llmService: LLMOrchestrator;                // ← 注入的 LLM 实例（修 N1）
  /** 压缩上限（token 估算），默认 {@link COMPRESSION_TOKENS_DEFAULT} */
  maxCompressionTokens?: number;
  fs: FileSystem;
  audit: AuditLog;
  /** 临时构建 per-claw FileSystem 的 factory（memory/system.ts 注入 / 业务 0 触 L1 impl）*/
  clawFsFactory: (clawDir: string) => FileSystem;
  /** phase 1162 Step C: caller-bound target-claw fail-loud notification */
  notifyClaw: DeepDreamNotifyClawFn;
  signal?: AbortSignal;
}

// ─── 工具函数 ────────────────────────────────────────────────

/** 从 ContentBlock[] 或 string 中提取纯文本 */
function extractText(content: ContentBlock[] | string): string {
  if (typeof content === 'string') return content;
  return content
    .filter((b): b is TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('');
}

/** 从 LLMResponse 中提取文本回复 */
function responseText(res: LLMResponse): string {
  return extractText(res.content as ContentBlock[]);
}

/** 将 SessionData.messages 序列化为可读文本（忽略 thinking/tool_use/tool_result 块） */
function serializeSession(messages: Message[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    if (msg.role === 'system') continue;
    const text = extractText(msg.content as ContentBlock[] | string).trim();
    if (!text) continue;
    const label = msg.role === 'user' ? '[User]' : '[Assistant]';
    lines.push(`${label} ${text}`);
  }
  return lines.join('\n\n');
}

// ─── Dream State I/O ─────────────────────────────────────────

const DEEP_DREAM_STATE_FILE = '.deep-dream-state.json';

function loadDreamState(clawFs: FileSystem, audit: AuditLog, clawId: string): DeepDreamStateLoadResult {
  // phase 1810 Step B: typed 四态 load（owner policy 归 dream-state-load.ts）
  const loaded = loadDreamStateRaw(clawFs, DEEP_DREAM_STATE_FILE);
  switch (loaded.kind) {
    case 'absent':
      // FileNotFoundError 首启良性 / silent
      return ready(defaultDreamState());
    case 'unavailable':
      // IO 故障（EACCES 等）不隐式转 default：不读不写、不 quarantine，degraded 保留证据
      audit.write(MEMORY_AUDIT_EVENTS.DEEP_DREAM_ERROR,
        `step=load_state`,
        `clawId=${clawId}`,
        `cause=unavailable`,
        `reason=${loaded.error}`,
      );
      return { status: 'degraded', degraded: { cause: 'unavailable', error: loaded.error } };
    case 'malformed': {
      // 损坏 state：先原子 quarantine raw（唯一后缀、不覆盖旧 raw），证据先于任何 reset；
      // quarantine 失败原文件不动，绝不因隔离失败而覆盖原始 state。
      const quarantine = quarantineDreamStateRaw(clawFs, DEEP_DREAM_STATE_FILE);
      audit.write(MEMORY_AUDIT_EVENTS.DEEP_DREAM_ERROR,
        `step=load_state`,
        `clawId=${clawId}`,
        `cause=malformed`,
        `reason=${loaded.error}`,
        quarantine.kind === 'quarantined'
          ? `quarantine=${quarantine.path}`
          : `quarantine=failed:${quarantine.error}`,
      );
      return { status: 'degraded', degraded: { cause: 'malformed', error: loaded.error, quarantine } };
    }
    case 'found': {
      const raw = loaded.raw;

    // phase 926 + 1161: reject future schema versions (keep file, block this claw)
    const version = typeof raw.schema_version === 'number' ? raw.schema_version : 0;
    if (version > DEEP_DREAM_STATE_CURRENT_VERSION) {
      audit.write(MEMORY_AUDIT_EVENTS.DREAM_STATE_FUTURE_VERSION,
        `version=${version}`,
        `current=${DEEP_DREAM_STATE_CURRENT_VERSION}`,
        `clawId=${clawId}`,
        `reason=cannot_migrate_future_version`,
      );
      return { status: 'blocked', reason: 'future_schema', version };
    }

    // phase 1162 Step B: normalize v1/v2 state into current schema (pending outbox + filters)
    return ready(normalizeDreamState(raw, audit, clawId));
    }
  }
}

function saveDreamState(
  clawFs: FileSystem,
  state: DreamStateData,
  audit: AuditLog,
  clawId: string,
): boolean {
  // phase 247 Step A: schema invariant
  assertDreamStateShape(state, audit, 'deep_dream_save');

  // phase 280: internal self-consistency audit（DC-3 retry bound）
  auditDeepDreamCrossSource(state, audit);

  try {
    // phase 547 / phase 1162 Step B: 总写 schema_version；确保当前版本最终生效
    const stateToSave = { ...state, schema_version: DEEP_DREAM_STATE_CURRENT_VERSION };
    clawFs.writeAtomicSync(DEEP_DREAM_STATE_FILE, JSON.stringify(stateToSave, null, 2));
    return true;
  } catch (err) {
    audit.write(MEMORY_AUDIT_EVENTS.DEEP_DREAM_ERROR,
      `step=save_state`,
      `clawId=${clawId}`,
      `reason=${formatErr(err)}`,
    );
    // F36: do not re-throw — preserve progress of successfully processed files
    return false;
  }
}

// ─── 文件发现 ─────────────────────────────────────────────────

interface SessionFile {
  filename: string;       // 用于 state 追踪（archive）或 CURRENT_DIALOG_FILE
  tsMs: number;           // 时间戳，用于排序
}

async function discoverUnprocessed(dialogStore: DialogStore, state: DreamStateData, today: string): Promise<SessionFile[]> {
  const files: SessionFile[] = [];

  // archive 文件（文件名: {tsMs}_{uuid8}.json）
  const archives = await dialogStore.listArchives();
  for (const name of archives) {
    const tsMs = parseInt(name.split('_')[0], 10);
    if (isNaN(tsMs)) continue;
    if (tsMs <= state.lastProcessedDeepDreamAt) continue;   // ← 高水位线 filter
    files.push({ filename: name, tsMs });
  }

  // current.json（当日未处理）
  if (
    state.currentSessionDreamedDate !== today &&
    await dialogStore.hasCurrent()
  ) {
    files.push({ filename: CURRENT_DIALOG_FILE, tsMs: Date.now() });
  }

  // 按时间戳升序，current.json 因为 tsMs=Date.now() 天然排在最后
  files.sort((a, b) => a.tsMs - b.tsMs);
  return files;
}

// ─── 压缩管理 ─────────────────────────────────────────────────

async function maybeMergeCompressions(
  compressions: string[],
  maxTokens: number,
  llm: LLMOrchestrator,
  signal?: AbortSignal,
): Promise<string[]> {
  const total = estimateTextTokens(compressions.join(''));
  if (total <= maxTokens) return compressions;

  // 元压缩：将所有段合并压一次
  const merged = compressions.join('\n---\n');
  const res = await llm.call({
    signal,
    messages: [
      { role: 'user', content: `${META_COMPRESSION_PROMPT}\n\n${merged}` },
    ],
  });
  return [responseText(res)];
}

// ─── 单 claw 处理 ─────────────────────────────────────────────

interface DreamRunContext {
  clawId: string;
  clawDir: string;
  clawFs: FileSystem;
  motionFs: FileSystem | undefined;
  llm: LLMOrchestrator;
  maxCompressionTokens: number;
  audit: AuditLog;
  /** phase 1162 Step C: caller-bound target-claw fail-loud notification */
  notifyClaw: DeepDreamNotifyClawFn;
  signal?: AbortSignal;
}

interface DreamRunPlan {
  state: DreamStateData;
  dialogStore: DialogStore;
  sessionFiles: SessionFile[];
  today: string;
}

// Phase 923: discriminated result so callers can distinguish success from any failure.
type ProcessResult =
  | { status: 'ok'; compressions: string[] }
  | { status: 'skip'; reason: string };

async function prepareDeepDreamRun(ctx: DreamRunContext): Promise<DreamRunPlan | null> {
  const today = new Date().toLocaleDateString('sv');
  const loaded = loadDreamState(ctx.clawFs, ctx.audit, ctx.clawId);
  if (loaded.status === 'degraded') {
    // phase 1810 Step B: 损坏/不可用 state 阻断本轮 run——不 discovery、不 LLM、不 save，
    // 新 canonical state 只能由下一轮 absent 路径在证据保全后建立（显式 reset gate）。
    ctx.audit.write(
      MEMORY_AUDIT_EVENTS.DEEP_DREAM_JOB,
      'step=blocked',
      `clawId=${ctx.clawId}`,
      `reason=state_${loaded.degraded.cause}`,
    );
    return null;
  }
  if (loaded.status === 'blocked') {
    ctx.audit.write(
      MEMORY_AUDIT_EVENTS.DEEP_DREAM_JOB,
      'step=blocked',
      `clawId=${ctx.clawId}`,
      `reason=${loaded.reason}`,
      `version=${loaded.version}`,
    );
    return null;
  }
  const recovered = await flushPendingDeepNotifications(ctx, loaded.state);
  if (recovered.status === 'deferred') return null;
  const state = recovered.state;

  const dialogStore = new DialogStore(ctx.clawFs, DIALOG_DIR, ctx.audit, CURRENT_DIALOG_FILE, ctx.clawId);
  const sessionFiles = await discoverUnprocessed(dialogStore, state, today);
  if (sessionFiles.length === 0) {
    ctx.audit.write(MEMORY_AUDIT_EVENTS.DEEP_DREAM_JOB, `step=skip_empty`, `clawId=${ctx.clawId}`);
    return null;
  }
  ctx.audit.write(MEMORY_AUDIT_EVENTS.DEEP_DREAM_JOB, `step=started`, `clawId=${ctx.clawId}`, `session_count=${sessionFiles.length}`);
  return { state, dialogStore, sessionFiles, today };
}

async function processSession(
  ctx: DreamRunContext,
  sf: SessionFile,
  plan: DreamRunPlan,
  compressions: string[],
  dreamOutputs: string[],
): Promise<ProcessResult> {
  let sessionData: SessionData;
  try {
    if (sf.filename === CURRENT_DIALOG_FILE) {
      const result = await plan.dialogStore.load();
      if (result.source === 'io_error') {
        ctx.audit.write(MEMORY_AUDIT_EVENTS.DEEP_DREAM_ERROR,
          `step=load_session`,
          `clawId=${ctx.clawId}`,
          `reason=${result.error}`,
        );
        return { status: 'skip', reason: 'io_error' };
      }
      if (result.source !== 'current') return { status: 'skip', reason: 'not_current' };
      sessionData = result.session;
    } else {
      sessionData = await plan.dialogStore.readArchive(sf.filename);
    }
  } catch (err) {
    ctx.audit.write(MEMORY_AUDIT_EVENTS.DEEP_DREAM_ERROR,
      `step=read_session`,
      `clawId=${ctx.clawId}`,
      `file=${sf.filename}`,
      `reason=${formatErr(err)}`,
    );
    if (sf.filename !== CURRENT_DIALOG_FILE) {
      // Phase 990: DialogIOError is transient (don't advance waterline, retry next cycle).
      // CorruptionError or any other unknown error is permanent (advance waterline).
      if (err instanceof DialogIOError) {
        // Transient error — stop processing.
        // Don't advance waterline. Next dream cycle will retry from this file.
        // runDeepDreamForClaw breaks the loop on any 'skip' result.
        return { status: 'skip', reason: 'transient_io' };
      }
      // ENOENT, CorruptionError, or any other error — advance waterline to skip permanently
      plan.state.lastProcessedDeepDreamAt = Math.max(plan.state.lastProcessedDeepDreamAt, sf.tsMs);
      return { status: 'skip', reason: 'permanent_io' };
    }
    const retryCount = (plan.state.currentSessionRetryCount ?? 0) + 1;
    plan.state.currentSessionRetryCount = retryCount;
    if (retryCount >= 3) {
      ctx.audit.write(MEMORY_AUDIT_EVENTS.DEEP_DREAM_RETRY_EXHAUSTED,
        `clawId=${ctx.clawId}`,
        `file=${sf.filename}`,
        `retries=${retryCount}`,
      );
      plan.state.lastProcessedDeepDreamAt = Math.max(plan.state.lastProcessedDeepDreamAt, sf.tsMs);
    }
    return { status: 'skip', reason: 'current_io' };
  }

  const sessionText = serializeSession(sessionData.messages ?? []);
  if (!sessionText.trim()) {
    if (sf.filename !== CURRENT_DIALOG_FILE) plan.state.lastProcessedDeepDreamAt = Math.max(plan.state.lastProcessedDeepDreamAt, sf.tsMs);
    return { status: 'skip', reason: 'empty_session' };
  }

  const userMsg: Message = { role: 'user', content: buildDreamInput(compressions, sessionText) };
  let dreamOutput: string;
  try {
    const res = await ctx.llm.call({ signal: ctx.signal, system: DEEP_DREAM_SYSTEM_PROMPT, messages: [userMsg] });
    dreamOutput = responseText(res);
  } catch (err) {
    ctx.audit.write(MEMORY_AUDIT_EVENTS.DEEP_DREAM_CALL_FAILED, `step=call_1`, `clawId=${ctx.clawId}`, `file=${sf.filename}`, `reason=${formatErr(err)}`);
    // Phase 923: current.json LLM failure counts as a retry; don't mark current as dreamed.
    if (sf.filename === CURRENT_DIALOG_FILE) {
      plan.state.currentSessionRetryCount = (plan.state.currentSessionRetryCount ?? 0) + 1;
    }
    return { status: 'skip', reason: 'llm_call_failed' };
  }

  dreamOutputs.push(`### ${sf.filename}\n\n${dreamOutput}`);

  let compression: string;
  try {
    const res = await ctx.llm.call({
      signal: ctx.signal,
      messages: [
        userMsg,
        { role: 'assistant', content: dreamOutput },
        { role: 'user', content: COMPRESSION_PROMPT },
      ],
    });
    compression = responseText(res);
  } catch (err) {
    ctx.audit.write(MEMORY_AUDIT_EVENTS.DEEP_DREAM_CALL_FAILED, `step=call_2`, `clawId=${ctx.clawId}`, `file=${sf.filename}`, `reason=${formatErr(err)}`);
    compression = dreamOutput.slice(0, ctx.maxCompressionTokens);
  }

  compressions.push(compression);
  const merged = await maybeMergeCompressions(compressions, ctx.maxCompressionTokens, ctx.llm, ctx.signal);

  if (sf.filename !== CURRENT_DIALOG_FILE) {
    plan.state.lastProcessedDeepDreamAt = Math.max(plan.state.lastProcessedDeepDreamAt, sf.tsMs);
  }
  return { status: 'ok', compressions: merged };
}

// ─── durable Deep Dream notification delivery ────────────────

const DELIVERY_META_KEY = 'delivery_id';
const DONE_DEDUP_WINDOW_MS = Number.POSITIVE_INFINITY;

function buildPendingDeepNotification(
  clawId: string,
  state: DreamStateData,
  body: string,
  sessionCount: number,
): PendingDeepDreamNotification {
  return {
    deliveryId: [
      'deep-dream', clawId,
      state.lastProcessedDeepDreamAt,
      state.currentSessionDreamedDate || 'none',
      sha256ShortHex(body, 16),
    ].join(':'),
    body,
    sessionCount,
    createdAt: Date.now(),
  };
}

function toDeepDreamMessage(item: PendingDeepDreamNotification): InboxMessageOptionsBase {
  return {
    type: 'deep_dream',
    source: 'cron-dream',
    priority: 'low',
    body: item.body,
    idPrefix: `${item.createdAt}_deep_dream`,
    extraFields: {
      session_count: String(item.sessionCount),
      [DELIVERY_META_KEY]: item.deliveryId,
    },
  };
}

type DeepNotificationFlushResult =
  | { status: 'confirmed'; state: DreamStateData }
  | { status: 'deferred'; state: DreamStateData };

async function flushPendingDeepNotifications(
  ctx: DreamRunContext,
  state: DreamStateData,
): Promise<DeepNotificationFlushResult> {
  const reader = new InboxReader(
    INBOX_PENDING_DIR, INBOX_DONE_DIR, INBOX_FAILED_DIR,
    ctx.clawFs, ctx.audit,
  );
  let current = state;
  for (const item of current.pendingNotifications ?? []) {
    let existing;
    try {
      existing = await reader.findByExtraMeta(
        DELIVERY_META_KEY, item.deliveryId,
        { includeDoneWithinMs: DONE_DEDUP_WINDOW_MS },
      );
    } catch (error) {
      ctx.audit.write(MEMORY_AUDIT_EVENTS.DEEP_DREAM_ERROR,
        'step=delivery_query', `clawId=${ctx.clawId}`, `reason=${formatErr(error)}`);
      return { status: 'deferred', state: current };
    }
    if (!existing) {
      try {
        await ctx.notifyClaw(ctx.clawId, toDeepDreamMessage(item));
      } catch (error) {
        ctx.audit.write(MEMORY_AUDIT_EVENTS.DEEP_DREAM_ERROR,
          'step=delivery_send', `clawId=${ctx.clawId}`, `reason=${formatErr(error)}`);
        return { status: 'deferred', state: current };
      }
    }
    const next = {
      ...current,
      pendingNotifications: current.pendingNotifications?.filter(
        candidate => candidate.deliveryId !== item.deliveryId,
      ),
    };
    if (!saveDreamState(ctx.clawFs, next, ctx.audit, ctx.clawId)) {
      return { status: 'deferred', state: current };
    }
    current = next;
  }
  return { status: 'confirmed', state: current };
}

async function persistDreamRun(
  ctx: DreamRunContext,
  plan: DreamRunPlan,
  dreamOutputs: string[],
  currentProcessed: boolean,
): Promise<void> {
  let dreamOutput = '';

  if (dreamOutputs.length > 0) {
    dreamOutput = dreamOutputs.join('\n\n---\n\n');

    if (ctx.motionFs) {
      const dreamId = `${Date.now()}_${ctx.clawId}`;
      const dreamOutputPath = `${MEMORY_DREAM_OUTPUTS_DIR}/${dreamId}.txt`;
      await ctx.motionFs.ensureDir(MEMORY_DREAM_OUTPUTS_DIR);
      await ctx.motionFs.writeAtomic(dreamOutputPath, dreamOutput);
      ctx.audit.write(
        MEMORY_AUDIT_EVENTS.DREAM_OUTPUT_PERSISTED,
        `dreamId=${dreamId}`,
        `path=${dreamOutputPath}`,
        `bytes=${dreamOutput.length}`,
      );
    }
  }

  // Phase 923 / Phase 1162 Step D: commit progress + pending notification atomically,
  // then flush. If any stage fails, disk retains pending for recovery.
  const progressState: DreamStateData = {
    lastProcessedDeepDreamAt: plan.state.lastProcessedDeepDreamAt,
    currentSessionDreamedDate: currentProcessed ? plan.today : plan.state.currentSessionDreamedDate,
    currentSessionRetryCount: currentProcessed ? 0 : plan.state.currentSessionRetryCount,
  };

  if (dreamOutputs.length === 0) {
    saveDreamState(ctx.clawFs, progressState, ctx.audit, ctx.clawId);
    return;
  }

  const notification = buildPendingDeepNotification(
    ctx.clawId, progressState, dreamOutput, dreamOutputs.length,
  );
  const staged: DreamStateData = {
    ...progressState,
    pendingNotifications: [
      ...(plan.state.pendingNotifications ?? []).filter(
        old => old.deliveryId !== notification.deliveryId,
      ),
      notification,
    ],
  };
  if (!saveDreamState(ctx.clawFs, staged, ctx.audit, ctx.clawId)) return;
  await flushPendingDeepNotifications(ctx, staged);

  ctx.audit.write(MEMORY_AUDIT_EVENTS.DEEP_DREAM_JOB, `step=finished`, `clawId=${ctx.clawId}`, `dream_count=${dreamOutputs.length}`);
}

async function runDeepDreamForClaw(
  clawId: string,
  clawDir: string,
  clawFs: FileSystem,
  motionFs: FileSystem | undefined,
  llm: LLMOrchestrator,
  maxCompressionTokens: number,
  audit: AuditLog,
  notifyClaw: DeepDreamNotifyClawFn,
  signal?: AbortSignal,
): Promise<void> {
  const ctx: DreamRunContext = { clawId, clawDir, clawFs, motionFs, llm, maxCompressionTokens, audit, notifyClaw, signal };
  const plan = await prepareDeepDreamRun(ctx);
  if (!plan) return;

  let compressions: string[] = [];
  const dreamOutputs: string[] = [];
  let currentProcessed = false;

  for (const sf of plan.sessionFiles) {
    const result = await processSession(ctx, sf, plan, compressions, dreamOutputs);
    if (result.status === 'skip') break; // Phase 923: any failure stops; don't advance waterline past failed files.
    compressions = result.compressions;
    if (sf.filename === CURRENT_DIALOG_FILE) currentProcessed = true;
  }

  await persistDreamRun(ctx, plan, dreamOutputs, currentProcessed);
}


// ─── 主函数 ───────────────────────────────────────────────────

// phase 1467: export internal pure helpers for test coverage (F9 from audit-2026-05-30).
// API surface unchanged for production callers (runDeepDream stays the only public entry).
// `__test_*` 前缀 + `@internal` JSDoc 双标记防误用。
/** @internal test-only export (phase 1467) */
export const __test_extractText = extractText;
/** @internal test-only export (phase 1467) */
export const __test_responseText = responseText;
/** @internal test-only export (phase 1467) */
export const __test_serializeSession = serializeSession;
/** @internal test-only export (phase 1467) */
export const __test_estimateTokens = estimateTextTokens;
/** @internal test-only export (phase 1467) */
export const __test_loadDreamState = loadDreamState;
/** @internal test-only export (phase 1467) */
export const __test_saveDreamState = saveDreamState;
/** @internal test-only export (phase 1467) */
export const __test_DEEP_DREAM_STATE_FILE = DEEP_DREAM_STATE_FILE;
export type { DreamStateData as __test_DreamStateData };
/** @internal test-only export (phase 1161) */
export type { DeepDreamStateLoadResult as __test_DeepDreamStateLoadResult };

// Phase 921: test-only exports for transient waterline behavior.
/** @internal test-only export (phase 921) */
export const __test_processSession = processSession;
/** @internal test-only export (phase 921) */
export type { DreamRunContext as __test_DreamRunContext };
/** @internal test-only export (phase 921) */
export type { DreamRunPlan as __test_DreamRunPlan };
/** @internal test-only export (phase 921) */
export type { SessionFile as __test_SessionFile };

// Phase 923: test-only exports for process/persist behavior.
/** @internal test-only export (phase 923) */
export const __test_persistDreamRun = persistDreamRun;
/** @internal test-only export (phase 923) */
export type { ProcessResult as __test_ProcessResult };

// Phase 1162 Step D: test-only exports for durable delivery behavior.
/** @internal test-only export (phase 1162) */
export type { DeepNotificationFlushResult as __test_DeepNotificationFlushResult };
/** @internal test-only export (phase 1162) */
export type { PendingDeepDreamNotification as __test_PendingDeepDreamNotification };

export async function runDeepDream(opts: DeepDreamOptions): Promise<void> {
  const maxCompressionTokens = opts.maxCompressionTokens ?? COMPRESSION_TOKENS_DEFAULT;
  if (!opts.fs.existsSync(CLAWS_DIR)) {
    opts.audit.write(MEMORY_AUDIT_EVENTS.DEEP_DREAM_JOB,
      `step=skipped_no_claws_dir`,
      `path=${CLAWS_DIR}`);
    return;
  }

  const clawIds = opts.clawTopology.enumerate().filter(id => id !== MOTION_CLAW_ID);
  if (clawIds.length === 0) return;

  const llm = opts.llmService;   // ← 使用注入的 LLM（修 N1）

  // 串行处理每个 claw
  for (const clawId of clawIds) {
    try {
      const location = opts.clawTopology.resolve(clawId);
      if (location.kind !== 'local') continue;
      const clawFs = opts.clawFsFactory(location.clawDir);
      await runDeepDreamForClaw(clawId, location.clawDir, clawFs, opts.motionFs, llm, maxCompressionTokens, opts.audit, opts.notifyClaw, opts.signal);
    } catch (err) {
      opts.audit.write(MEMORY_AUDIT_EVENTS.DEEP_DREAM_UNEXPECTED, `step=unexpected`, `clawId=${clawId}`, `reason=${formatErr(err)}`);
      // 单 claw 失败不阻断其他 claw
    }
  }
  // 注意：不再调 llm.close() —— LLM 生命周期由 Assembly 管理
}
