import * as path from 'path';
import type { FileSystem } from '../../foundation/fs/types.js';
import { MEMORY_AUDIT_EVENTS } from './audit-events.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { LLMOrchestrator } from '../../foundation/llm-orchestrator/index.js';
import type { LLMOrchestratorConfig } from '../../foundation/llm-orchestrator/index.js';
import type { Message, ContentBlock, TextBlock, LLMResponse } from '../../foundation/llm-provider/types.js';
import { notifyInbox } from '../../foundation/messaging/index.js';
import { createSystemAudit } from '../../foundation/audit/index.js';
import { type ClawId, makeClawId } from '../../foundation/identity/index.js'
import { type ClawforumRoot } from '../../foundation/identity/index.js';
import { DialogStore } from '../../foundation/dialog-store/index.js';
import type { SessionData } from '../../foundation/dialog-store/types.js';
import { CLAWS_DIR } from '../../foundation/paths.js';
import { INBOX_PENDING_DIR } from '../../foundation/messaging/dirs.js';
import { FileNotFoundError } from '../../foundation/fs/types.js';
import { type ClawDir, makeClawDir } from '../../foundation/identity/index.js';
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
  clawforumRoot: ClawforumRoot;                  // .clawforum/ 根目录
  motionDir?: string;                    // motion 域 / dream-outputs 归属
  motionFs?: FileSystem;                 // baseDir = motionDir
  llmConfig: LLMOrchestratorConfig;
  llmService: LLMOrchestrator;                // ← 注入的 LLM 实例（修 N1）
  maxCompressionTokens?: number;         // 压缩上限（token 估算），默认 4000
  fs: FileSystem;
  audit: AuditLog;
  /** 临时构建 per-claw FileSystem 的 factory（memory/system.ts 注入 / 业务 0 触 L1 impl）*/
  clawFsFactory: (clawDir: ClawDir) => FileSystem;
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

function loadDreamState(clawFs: FileSystem, audit: AuditLog, clawId: ClawId): DreamStateData {
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
      `reason=${err instanceof Error ? err.message : String(err)}`,
    );
    return { processedArchives: [], currentSessionDreamedDate: '' };
  }
}

function saveDreamState(clawFs: FileSystem, state: DreamStateData, audit: AuditLog, clawId: ClawId): void {
  try {
    clawFs.writeAtomicSync(DEEP_DREAM_STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    audit.write(MEMORY_AUDIT_EVENTS.DEEP_DREAM_ERROR,
      `step=save_state`,
      `clawId=${clawId}`,
      `reason=${err instanceof Error ? err.message : String(err)}`,
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

async function runDeepDreamForClaw(
  clawId: ClawId,
  clawDir: ClawDir,
  clawFs: FileSystem,
  motionFs: FileSystem | undefined,
  llm: LLMOrchestrator,
  maxCompressionTokens: number,
  audit: AuditLog,
  signal?: AbortSignal,
): Promise<void> {
  const today = new Date().toLocaleDateString('sv');   // ← 统一在此计算
  const state = loadDreamState(clawFs, audit, clawId);
  // DialogStore 管理 dialog 资源的唯一入口（M#3）
  const dialogStore = new DialogStore(clawFs, 'dialog', audit, 'current.json', clawId);
  const sessionFiles = await discoverUnprocessed(dialogStore, state, today);  // ← 传入 today

  if (sessionFiles.length === 0) {
    audit.write(MEMORY_AUDIT_EVENTS.DEEP_DREAM_JOB, `step=skip_empty`, `clawId=${clawId}`);
    return;
  }

  audit.write(MEMORY_AUDIT_EVENTS.DEEP_DREAM_JOB, `step=started`, `clawId=${clawId}`, `session_count=${sessionFiles.length}`);

  let compressions: string[] = [];
  const dreamOutputs: string[] = [];
  const processedArchives: string[] = [];

  for (const sf of sessionFiles) {
    // 读取并序列化会话（走 DialogStore 公开 API：version migration + validation 已封装）
    let sessionData: SessionData;
    try {
      if (sf.filename === 'current.json') {
        const result = await dialogStore.load();
        // current.json 损坏/缺失时 DialogStore 内部走 archive 恢复或 cold start。
        // deep-dream 只处理真正的 current session（source='current'），
        // 其他情况（archive 恢复 / empty）跳过，保留当日重试可能。
        if (result.source !== 'current') {
          continue;
        }
        sessionData = result.session;
      } else {
        sessionData = await dialogStore.readArchive(sf.filename);
      }
    } catch (err) {
      audit.write(MEMORY_AUDIT_EVENTS.DEEP_DREAM_ERROR,
        `step=read_session`,
        `clawId=${clawId}`,
        `file=${sf.filename}`,
        `reason=${err instanceof Error ? err.message : String(err)}`,
      );
      // 损坏 archive 永标记跳过（防 retry-storm / mirror line 198-201 空 session 模式）
      if (sf.filename !== 'current.json') {
        processedArchives.push(sf.filename);
        continue;
      }
      // Phase 1200: current.json retry stop-loss (max 3 attempts per day)
      const retryCount = (state.currentSessionRetryCount ?? 0) + 1;
      state.currentSessionRetryCount = retryCount;
      if (retryCount >= 3) {
        audit.write(MEMORY_AUDIT_EVENTS.DEEP_DREAM_RETRY_EXHAUSTED,
          `clawId=${clawId}`,
          `file=${sf.filename}`,
          `retries=${retryCount}`,
        );
        // Mark as processed to stop further retries today
        processedArchives.push(sf.filename);
      }
      continue;
    }
    const sessionText = serializeSession(sessionData.messages ?? []);
    if (!sessionText.trim()) {
      // 空会话跳过，但仍标记为已处理
      if (sf.filename !== 'current.json') processedArchives.push(sf.filename);
      continue;
    }

    // Call 1：梦境生成
    const userMsg: Message = {
      role: 'user',
      content: buildDreamInput(compressions, sessionText),
    };
    let dreamOutput: string;
    try {
      const res = await llm.call({
        signal,
        system: DEEP_DREAM_SYSTEM_PROMPT,
        messages: [userMsg],
      });
      dreamOutput = responseText(res);
    } catch (err) {
      audit.write(MEMORY_AUDIT_EVENTS.DEEP_DREAM_CALL_FAILED, `step=call_1`, `clawId=${clawId}`, `file=${sf.filename}`, `reason=${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    dreamOutputs.push(`### ${sf.filename}\n\n${dreamOutput}`);

    // Call 2：压缩
    let compression: string;
    try {
      const res = await llm.call({
        signal,
        messages: [
          userMsg,
          { role: 'assistant', content: dreamOutput },
          { role: 'user', content: COMPRESSION_PROMPT },
        ],
      });
      compression = responseText(res);
    } catch (err) {
      audit.write(MEMORY_AUDIT_EVENTS.DEEP_DREAM_CALL_FAILED, `step=call_2`, `clawId=${clawId}`, `file=${sf.filename}`, `reason=${err instanceof Error ? err.message : String(err)}`);
      // 压缩失败不阻断流程，截取前 maxCompressionTokens chars 防 meta-compression 超上下文
      compression = dreamOutput.slice(0, maxCompressionTokens);
    }

    compressions.push(compression);
    compressions = await maybeMergeCompressions(compressions, maxCompressionTokens, llm, signal);

    if (sf.filename !== 'current.json') {
      processedArchives.push(sf.filename);
    }
  }

  // 更新 state（无论是否有梦境输出，都记录已处理的 archive 文件）
  if (processedArchives.length > 0 || sessionFiles.some(f => f.filename === 'current.json')) {
    const currentProcessedToday = sessionFiles.some(f => f.filename === 'current.json');
    const updatedState: DreamStateData = {
      processedArchives: [...new Set([...state.processedArchives, ...processedArchives])],
      currentSessionDreamedDate: currentProcessedToday
        ? today
        : state.currentSessionDreamedDate,
      // Phase 1200: reset retry count when current.json is successfully processed
      currentSessionRetryCount: currentProcessedToday ? 0 : state.currentSessionRetryCount,
    };
    saveDreamState(clawFs, updatedState, audit, clawId);
  }

  if (dreamOutputs.length === 0) return;

  const dreamOutput = dreamOutputs.join('\n\n---\n\n');

  // NEW: disk snapshot（motion 域）
  if (motionFs) {
    const dreamId = `${Date.now()}_${clawId}`;
    const dreamOutputPath = `memory/dream-outputs/${dreamId}.txt`;
    await motionFs.ensureDir('memory/dream-outputs');
    await motionFs.writeAtomic(dreamOutputPath, dreamOutput);
    audit.write(
      MEMORY_AUDIT_EVENTS.DREAM_OUTPUT_PERSISTED,
      `dreamId=${dreamId}`,
      `path=${dreamOutputPath}`,
      `bytes=${dreamOutput.length}`,
    );
  }

  // 投递到 claw inbox（self-notify / chrooted fs / 走 deprecated notifyInbox helper）
  const clawAudit = createSystemAudit(clawFs, clawDir);
  notifyInbox(clawFs, {
    inboxDir: INBOX_PENDING_DIR,
    type: 'deep_dream',
    source: 'cron:dream',
    priority: 'low',
    body: dreamOutput,
    idPrefix: `${Date.now()}_deep_dream`,
    extraFields: { session_count: String(dreamOutputs.length) },
  }, clawAudit);

  audit.write(MEMORY_AUDIT_EVENTS.DEEP_DREAM_JOB, `step=finished`, `clawId=${clawId}`, `dream_count=${dreamOutputs.length}`);
}

// ─── 主函数 ───────────────────────────────────────────────────

export async function runDeepDream(opts: DeepDreamOptions): Promise<void> {
  const maxCompressionTokens = opts.maxCompressionTokens ?? 4000;
  if (!opts.fs.existsSync(CLAWS_DIR)) return;

  const clawIds = opts.fs.listSync(CLAWS_DIR, { includeDirs: true })
    .filter(e => opts.fs.statSync(path.join(CLAWS_DIR, e.name)).isDirectory)
    .map(e => e.name);

  if (clawIds.length === 0) return;

  const llm = opts.llmService;   // ← 使用注入的 LLM（修 N1）

  // 串行处理每个 claw
  for (const clawId of clawIds) {
    const clawDir = makeClawDir(path.join(opts.clawforumRoot, CLAWS_DIR, clawId));
    try {
      const clawFs = opts.clawFsFactory(clawDir);
      await runDeepDreamForClaw(makeClawId(clawId), clawDir, clawFs, opts.motionFs, llm, maxCompressionTokens, opts.audit, opts.signal);
    } catch (err) {
      opts.audit.write(MEMORY_AUDIT_EVENTS.DEEP_DREAM_UNEXPECTED, `step=unexpected`, `clawId=${clawId}`, `reason=${err instanceof Error ? err.message : String(err)}`);
      // 单 claw 失败不阻断其他 claw
    }
  }
  // 注意：不再调 llm.close() —— LLM 生命周期由 Assembly 管理
}
