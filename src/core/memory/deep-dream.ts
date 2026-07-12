import { formatErr } from "../../foundation/node-utils/index.js";
import type { FileSystem } from '../../foundation/fs/index.js';
import { MEMORY_AUDIT_EVENTS } from './audit-events.js';
import { MEMORY_DREAM_OUTPUTS_DIR } from './memory-paths.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { LLMOrchestrator } from '../../foundation/llm-orchestrator/index.js';
import type { LLMOrchestratorConfig } from '../../foundation/llm-orchestrator/index.js';
import type { Message, ContentBlock, TextBlock, LLMResponse } from '../../foundation/llm-provider/index.js';
import { notifyInbox } from '../../foundation/messaging/index.js';
import { estimateTextTokens } from '../../foundation/llm-provider/index.js';
import { createSystemAudit } from '../../foundation/audit/index.js';
import { DialogStore, DIALOG_DIR, CURRENT_DIALOG_FILE } from '../../foundation/dialog-store/index.js';
import type { SessionData } from '../../foundation/dialog-store/index.js';
import { CLAWS_DIR } from '../../core/claw-topology/claw-instance-paths.js';
import { INBOX_PENDING_DIR } from '../../foundation/messaging/index.js';
import { FileNotFoundError } from '../../foundation/fs/index.js';
import { MOTION_CLAW_ID } from '../claw-topology/index.js';
import type { ClawTopology } from '../../core/claw-topology/index.js';
import { assertDreamStateShape } from './invariants.js';
import { auditDeepDreamCrossSource } from './dream-cross-source-audit.js';

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
 * v1 = 当前 schema；未来增/改字段时 ++version + 加 migration 路径。
 * 与 phase 280 'processedArchives' legacy 实体共存（legacy 是字段名 hint、未来 v2 用版本号 cleaner）。
 */
const DEEP_DREAM_STATE_CURRENT_VERSION = 1;

interface DreamStateData {
  schema_version?: number;               // phase 547: 显式 schema 版本（默认 1、未写也视 v1）
  lastProcessedDeepDreamAt: number;      // ms epoch 高水位线：archivedAt ≤ 此值的视为已处理
  currentSessionDreamedDate: string;     // "YYYY-MM-DD"，当日 current.json 已处理
  currentSessionRetryCount?: number;     // Phase 1200: current.json 损坏重试计数器
}

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

function loadDreamState(clawFs: FileSystem, audit: AuditLog, clawId: string): DreamStateData {
  try {
    const raw = JSON.parse(clawFs.readSync(DEEP_DREAM_STATE_FILE)) as Record<string, unknown>;

    // phase 280: legacy schema migration (option 2 silent reset + audit emit)
    if ('processedArchives' in raw) {
      audit.write(MEMORY_AUDIT_EVENTS.LEGACY_SCHEMA_MIGRATED_RESET,
        `kind=deep_dream`,
        `clawId=${clawId}`,
        `legacy_field=processedArchives`,
        `legacy_count=${Array.isArray(raw.processedArchives) ? raw.processedArchives.length : 0}`,
      );
      return { schema_version: DEEP_DREAM_STATE_CURRENT_VERSION, lastProcessedDeepDreamAt: 0, currentSessionDreamedDate: '', currentSessionRetryCount: 0 };
    }

    // phase 547: 缺 schema_version 视 v1（兼容旧 state 文件、未触发 migration audit）
    return raw as unknown as DreamStateData;
  } catch (err) {
    // FileNotFoundError 首启良性 / silent
    if (err instanceof FileNotFoundError) {
      return { schema_version: DEEP_DREAM_STATE_CURRENT_VERSION, lastProcessedDeepDreamAt: 0, currentSessionDreamedDate: '' };
    }
    // 其他 IO 错（parse 损坏 / 权限 / 等）必 audit + 返空 resilient
    audit.write(MEMORY_AUDIT_EVENTS.DEEP_DREAM_ERROR,
      `step=load_state`,
      `clawId=${clawId}`,
      `reason=${formatErr(err)}`,
    );
    return { schema_version: DEEP_DREAM_STATE_CURRENT_VERSION, lastProcessedDeepDreamAt: 0, currentSessionDreamedDate: '' };
  }
}

function saveDreamState(
  clawFs: FileSystem,
  state: DreamStateData,
  audit: AuditLog,
  clawId: string,
): void {
  // phase 247 Step A: schema invariant
  assertDreamStateShape(state, audit, 'deep_dream_save');

  // phase 280: internal self-consistency audit（DC-3 retry bound）
  auditDeepDreamCrossSource(state, audit);

  try {
    // phase 547: 总写 schema_version、迁老 state 文件升级
    const stateToSave = { schema_version: DEEP_DREAM_STATE_CURRENT_VERSION, ...state };
    clawFs.writeAtomicSync(DEEP_DREAM_STATE_FILE, JSON.stringify(stateToSave, null, 2));
  } catch (err) {
    audit.write(MEMORY_AUDIT_EVENTS.DEEP_DREAM_ERROR,
      `step=save_state`,
      `clawId=${clawId}`,
      `reason=${formatErr(err)}`,
    );
    // F36: do not re-throw — preserve progress of successfully processed files
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
  const state = loadDreamState(ctx.clawFs, ctx.audit, ctx.clawId);
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
      // Phase 921: distinguish transient from permanent errors.
      // Transient errors (EACCES, EIO, etc.) → don't advance waterline, retry next time.
      // Permanent errors (corrupt JSON, version unknown) → advance to avoid infinite retry.
      const errCode = (err as NodeJS.ErrnoException).code;
      const isTransient = errCode === 'EACCES' || errCode === 'EIO' || errCode === 'EBUSY' ||
                          errCode === 'EMFILE' || errCode === 'ENFILE' || errCode === 'ENOMEM';
      if (!isTransient) {
        plan.state.lastProcessedDeepDreamAt = Math.max(plan.state.lastProcessedDeepDreamAt, sf.tsMs);
      }
      return { status: 'skip', reason: isTransient ? 'transient_io' : 'permanent_io' };
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

  // Phase 923: commit state only after output is safely persisted.
  // If writeAtomic throws above, state remains unchanged → next cycle retries.
  const updatedState: DreamStateData = {
    lastProcessedDeepDreamAt: plan.state.lastProcessedDeepDreamAt,
    currentSessionDreamedDate: currentProcessed ? plan.today : plan.state.currentSessionDreamedDate,
    currentSessionRetryCount: currentProcessed ? 0 : plan.state.currentSessionRetryCount,
  };
  saveDreamState(ctx.clawFs, updatedState, ctx.audit, ctx.clawId);

  if (dreamOutputs.length > 0) {
    const clawAudit = createSystemAudit(ctx.clawFs, ctx.clawDir);
    notifyInbox(ctx.clawFs, {
      inboxDir: INBOX_PENDING_DIR,
      type: 'deep_dream',
      source: 'cron-dream',
      priority: 'low',
      body: dreamOutput,
      idPrefix: `${Date.now()}_deep_dream`,
      extraFields: { session_count: String(dreamOutputs.length) },
    }, clawAudit);
  }

  if (dreamOutputs.length > 0) {
    ctx.audit.write(MEMORY_AUDIT_EVENTS.DEEP_DREAM_JOB, `step=finished`, `clawId=${ctx.clawId}`, `dream_count=${dreamOutputs.length}`);
  }
}

async function runDeepDreamForClaw(
  clawId: string,
  clawDir: string,
  clawFs: FileSystem,
  motionFs: FileSystem | undefined,
  llm: LLMOrchestrator,
  maxCompressionTokens: number,
  audit: AuditLog,
  signal?: AbortSignal,
): Promise<void> {
  const ctx: DreamRunContext = { clawId, clawDir, clawFs, motionFs, llm, maxCompressionTokens, audit, signal };
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
export const __test_runDeepDreamForClaw = runDeepDreamForClaw;
/** @internal test-only export (phase 923) */
export type { ProcessResult as __test_ProcessResult };

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
      await runDeepDreamForClaw(clawId, location.clawDir, clawFs, opts.motionFs, llm, maxCompressionTokens, opts.audit, opts.signal);
    } catch (err) {
      opts.audit.write(MEMORY_AUDIT_EVENTS.DEEP_DREAM_UNEXPECTED, `step=unexpected`, `clawId=${clawId}`, `reason=${formatErr(err)}`);
      // 单 claw 失败不阻断其他 claw
    }
  }
  // 注意：不再调 llm.close() —— LLM 生命周期由 Assembly 管理
}
