import * as path from 'path';
import { formatErr } from "../../foundation/utils/index.js";
import type { FileSystem } from '../../foundation/fs/types.js';
import { MEMORY_AUDIT_EVENTS } from './audit-events.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { LLMOrchestrator } from '../../foundation/llm-orchestrator/index.js';
import type { LLMOrchestratorConfig } from '../../foundation/llm-orchestrator/index.js';
import type { Message, ContentBlock, TextBlock, LLMResponse } from '../../foundation/llm-provider/types.js';
import { notifyInbox } from '../../foundation/messaging/index.js';
import { createSystemAudit } from '../../foundation/audit/index.js';
import { DialogStore } from '../../foundation/dialog-store/index.js';
import type { SessionData } from '../../foundation/dialog-store/types.js';
import { CLAWS_DIR } from '../../assembly/claw-dirs.js';
import { INBOX_PENDING_DIR } from '../../foundation/messaging/index.js';
import { FileNotFoundError } from '../../foundation/fs/types.js';
import {
  DEEP_DREAM_SYSTEM_PROMPT,
  buildDreamInput,
  COMPRESSION_PROMPT,
  META_COMPRESSION_PROMPT,
} from './prompts/deep-dream.js';

// ─── 类型定义 ───────────────────────────────────────────────

interface DreamStateData {
  processedArchives: string[];           // 已处理的 archive 文件名（不含路径）
  currentSessionDreamedDate: string;     // "YYYY-MM-DD"，当日 current.json 已处理
  currentSessionRetryCount?: number;     // Phase 1200: current.json 损坏重试计数器
}

export interface DeepDreamOptions {
  clawsDir: string;                              // phase 84: caller (装配期) 算好 claws dir 后传入
  motionDir?: string;                    // motion 域 / dream-outputs 归属
  motionFs?: FileSystem;                 // baseDir = motionDir
  llmConfig: LLMOrchestratorConfig;
  llmService: LLMOrchestrator;                // ← 注入的 LLM 实例（修 N1）
  maxCompressionTokens?: number;         // 压缩上限（token 估算），默认 4000
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

/** 粗略估算 token 数（4 字符 ≈ 1 token） */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ─── Dream State I/O ─────────────────────────────────────────

const DEEP_DREAM_STATE_FILE = '.deep-dream-state.json';

function loadDreamState(clawFs: FileSystem, audit: AuditLog, clawId: string): DreamStateData {
  try {
    return JSON.parse(clawFs.readSync(DEEP_DREAM_STATE_FILE)) as DreamStateData;
  } catch (err) {
    // FileNotFoundError 首启良性 / silent
    if (err instanceof FileNotFoundError) {
      return { processedArchives: [], currentSessionDreamedDate: '' };
    }
    // 其他 IO 错（parse 损坏 / 权限 / 等）必 audit + 返空 resilient
    audit.write(MEMORY_AUDIT_EVENTS.DEEP_DREAM_ERROR,
      `step=load_state`,
      `clawId=${clawId}`,
      `reason=${formatErr(err)}`,
    );
    return { processedArchives: [], currentSessionDreamedDate: '' };
  }
}

function saveDreamState(clawFs: FileSystem, state: DreamStateData, audit: AuditLog, clawId: string): void {
  try {
    clawFs.writeAtomicSync(DEEP_DREAM_STATE_FILE, JSON.stringify(state, null, 2));
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
  filename: string;       // 用于 state 追踪（archive）或 'current.json'
  tsMs: number;           // 时间戳，用于排序
}

async function discoverUnprocessed(dialogStore: DialogStore, state: DreamStateData, today: string): Promise<SessionFile[]> {
  const processed = new Set(state.processedArchives);
  const files: SessionFile[] = [];

  // archive 文件（文件名: {tsMs}_{uuid8}.json）
  const archives = await dialogStore.listArchives();
  for (const name of archives) {
    if (processed.has(name)) continue;
    const tsMs = parseInt(name.split('_')[0], 10);
    if (isNaN(tsMs)) continue;
    files.push({ filename: name, tsMs });
  }

  // current.json（当日未处理）
  if (
    state.currentSessionDreamedDate !== today &&
    await dialogStore.hasCurrent()
  ) {
    files.push({ filename: 'current.json', tsMs: Date.now() });
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
  const total = estimateTokens(compressions.join(''));
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

async function prepareDeepDreamRun(ctx: DreamRunContext): Promise<DreamRunPlan | null> {
  const today = new Date().toLocaleDateString('sv');
  const state = loadDreamState(ctx.clawFs, ctx.audit, ctx.clawId);
  const dialogStore = new DialogStore(ctx.clawFs, 'dialog', ctx.audit, 'current.json', ctx.clawId);
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
  processedArchives: string[],
): Promise<string[]> {
  let sessionData: SessionData;
  try {
    if (sf.filename === 'current.json') {
      const result = await plan.dialogStore.load();
      if (result.source !== 'current') return compressions;
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
    if (sf.filename !== 'current.json') {
      processedArchives.push(sf.filename);
      return compressions;
    }
    const retryCount = (plan.state.currentSessionRetryCount ?? 0) + 1;
    plan.state.currentSessionRetryCount = retryCount;
    if (retryCount >= 3) {
      ctx.audit.write(MEMORY_AUDIT_EVENTS.DEEP_DREAM_RETRY_EXHAUSTED,
        `clawId=${ctx.clawId}`,
        `file=${sf.filename}`,
        `retries=${retryCount}`,
      );
      processedArchives.push(sf.filename);
    }
    return compressions;
  }

  const sessionText = serializeSession(sessionData.messages ?? []);
  if (!sessionText.trim()) {
    if (sf.filename !== 'current.json') processedArchives.push(sf.filename);
    return compressions;
  }

  const userMsg: Message = { role: 'user', content: buildDreamInput(compressions, sessionText) };
  let dreamOutput: string;
  try {
    const res = await ctx.llm.call({ signal: ctx.signal, system: DEEP_DREAM_SYSTEM_PROMPT, messages: [userMsg] });
    dreamOutput = responseText(res);
  } catch (err) {
    ctx.audit.write(MEMORY_AUDIT_EVENTS.DEEP_DREAM_CALL_FAILED, `step=call_1`, `clawId=${ctx.clawId}`, `file=${sf.filename}`, `reason=${formatErr(err)}`);
    return compressions;
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

  if (sf.filename !== 'current.json') {
    processedArchives.push(sf.filename);
  }
  return merged;
}

async function persistDreamRun(
  ctx: DreamRunContext,
  plan: DreamRunPlan,
  dreamOutputs: string[],
  processedArchives: string[],
): Promise<void> {
  if (processedArchives.length > 0 || plan.sessionFiles.some(f => f.filename === 'current.json')) {
    const currentProcessedToday = plan.sessionFiles.some(f => f.filename === 'current.json');
    const updatedState: DreamStateData = {
      processedArchives: [...new Set([...plan.state.processedArchives, ...processedArchives])],
      currentSessionDreamedDate: currentProcessedToday ? plan.today : plan.state.currentSessionDreamedDate,
      currentSessionRetryCount: currentProcessedToday ? 0 : plan.state.currentSessionRetryCount,
    };
    saveDreamState(ctx.clawFs, updatedState, ctx.audit, ctx.clawId);
  }

  if (dreamOutputs.length === 0) return;

  const dreamOutput = dreamOutputs.join('\n\n---\n\n');

  if (ctx.motionFs) {
    const dreamId = `${Date.now()}_${ctx.clawId}`;
    const dreamOutputPath = `memory/dream-outputs/${dreamId}.txt`;
    await ctx.motionFs.ensureDir('memory/dream-outputs');
    await ctx.motionFs.writeAtomic(dreamOutputPath, dreamOutput);
    ctx.audit.write(
      MEMORY_AUDIT_EVENTS.DREAM_OUTPUT_PERSISTED,
      `dreamId=${dreamId}`,
      `path=${dreamOutputPath}`,
      `bytes=${dreamOutput.length}`,
    );
  }

  const clawAudit = createSystemAudit(ctx.clawFs, ctx.clawDir);
  notifyInbox(ctx.clawFs, {
    inboxDir: INBOX_PENDING_DIR,
    type: 'deep_dream',
    source: 'cron:dream',
    priority: 'low',
    body: dreamOutput,
    idPrefix: `${Date.now()}_deep_dream`,
    extraFields: { session_count: String(dreamOutputs.length) },
  }, clawAudit);

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
  signal?: AbortSignal,
): Promise<void> {
  const ctx: DreamRunContext = { clawId, clawDir, clawFs, motionFs, llm, maxCompressionTokens, audit, signal };
  const plan = await prepareDeepDreamRun(ctx);
  if (!plan) return;

  let compressions: string[] = [];
  const dreamOutputs: string[] = [];
  const processedArchives: string[] = [];

  for (const sf of plan.sessionFiles) {
    compressions = await processSession(ctx, sf, plan, compressions, dreamOutputs, processedArchives);
  }

  await persistDreamRun(ctx, plan, dreamOutputs, processedArchives);
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
export const __test_estimateTokens = estimateTokens;
/** @internal test-only export (phase 1467) */
export const __test_loadDreamState = loadDreamState;
/** @internal test-only export (phase 1467) */
export const __test_saveDreamState = saveDreamState;
/** @internal test-only export (phase 1467) */
export const __test_DEEP_DREAM_STATE_FILE = DEEP_DREAM_STATE_FILE;
export type { DreamStateData as __test_DreamStateData };

export async function runDeepDream(opts: DeepDreamOptions): Promise<void> {
  const maxCompressionTokens = opts.maxCompressionTokens ?? 4000;
  if (!opts.fs.existsSync(CLAWS_DIR)) {
    opts.audit.write(MEMORY_AUDIT_EVENTS.DEEP_DREAM_JOB,
      `step=skipped_no_claws_dir`,
      `path=${CLAWS_DIR}`);
    return;
  }

  const clawIds = opts.fs.listSync(CLAWS_DIR, { includeDirs: true })
    .filter(e => opts.fs.statSync(path.join(CLAWS_DIR, e.name)).isDirectory)
    .map(e => e.name);

  if (clawIds.length === 0) return;

  const llm = opts.llmService;   // ← 使用注入的 LLM（修 N1）

  // 串行处理每个 claw
  for (const clawId of clawIds) {
    const clawDir = path.join(opts.clawsDir, clawId);
    try {
      const clawFs = opts.clawFsFactory(clawDir);
      await runDeepDreamForClaw(clawId, clawDir, clawFs, opts.motionFs, llm, maxCompressionTokens, opts.audit, opts.signal);
    } catch (err) {
      opts.audit.write(MEMORY_AUDIT_EVENTS.DEEP_DREAM_UNEXPECTED, `step=unexpected`, `clawId=${clawId}`, `reason=${formatErr(err)}`);
      // 单 claw 失败不阻断其他 claw
    }
  }
  // 注意：不再调 llm.close() —— LLM 生命周期由 Assembly 管理
}
