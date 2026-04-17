import * as fs from 'fs';
import * as path from 'path';
import type { FileSystem } from '../../../foundation/fs/types.js';
import { LLMService } from '../../../foundation/llm/service.js';
import type { LLMServiceConfig } from '../../../foundation/llm/types.js';
import type { Message, ContentBlock, TextBlock, LLMResponse } from '../../../types/message.js';
import { writeInboxMessage } from '../../../utils/inbox-writer.js';
import {
  DEEP_DREAM_SYSTEM_PROMPT,
  buildDreamInput,
  COMPRESSION_PROMPT,
  META_COMPRESSION_PROMPT,
} from '../../../prompts/deep-dream.js';

// ─── 类型定义 ───────────────────────────────────────────────

interface DreamStateData {
  processedArchives: string[];           // 已处理的 archive 文件名（不含路径）
  currentSessionDreamedDate: string;     // "YYYY-MM-DD"，当日 current.json 已处理
}

export interface DeepDreamOptions {
  clawforumDir: string;                  // .clawforum/ 根目录
  llmConfig: LLMServiceConfig;
  maxCompressionTokens?: number;         // 压缩上限（token 估算），默认 4000
  fs: FileSystem;
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

function statePath(clawDir: string): string {
  return path.join(clawDir, '.deep-dream-state.json');
}

function loadDreamState(clawDir: string): DreamStateData {
  try {
    return JSON.parse(fs.readFileSync(statePath(clawDir), 'utf-8')) as DreamStateData;
  } catch {
    return { processedArchives: [], currentSessionDreamedDate: '' };
  }
}

function saveDreamState(clawDir: string, state: DreamStateData): void {
  fs.writeFileSync(statePath(clawDir), JSON.stringify(state, null, 2), 'utf-8');
}

// ─── 文件发现 ─────────────────────────────────────────────────

interface SessionFile {
  filename: string;       // 用于 state 追踪（archive）或 'current.json'
  filePath: string;
  tsMs: number;           // 时间戳，用于排序
}

function discoverUnprocessed(clawDir: string, state: DreamStateData, today: string): SessionFile[] {
  const processed = new Set(state.processedArchives);
  const files: SessionFile[] = [];

  // archive 文件（文件名: {tsMs}_{uuid8}.json）
  const archiveDir = path.join(clawDir, 'dialog', 'archive');
  if (fs.existsSync(archiveDir)) {
    for (const name of fs.readdirSync(archiveDir)) {
      if (!name.endsWith('.json')) continue;
      if (processed.has(name)) continue;
      const tsMs = parseInt(name.split('_')[0], 10);
      if (isNaN(tsMs)) continue;
      files.push({ filename: name, filePath: path.join(archiveDir, name), tsMs });
    }
  }

  // current.json（当日未处理）
  const currentPath = path.join(clawDir, 'dialog', 'current.json');
  if (
    fs.existsSync(currentPath) &&
    state.currentSessionDreamedDate !== today
  ) {
    files.push({ filename: 'current.json', filePath: currentPath, tsMs: Date.now() });
  }

  // 按时间戳升序，current.json 因为 tsMs=Date.now() 天然排在最后
  files.sort((a, b) => a.tsMs - b.tsMs);
  return files;
}

// ─── 压缩管理 ─────────────────────────────────────────────────

async function maybeMergeCompressions(
  compressions: string[],
  maxTokens: number,
  llm: LLMService,
): Promise<string[]> {
  const total = estimateTokens(compressions.join(''));
  if (total <= maxTokens) return compressions;

  // 元压缩：将所有段合并压一次
  const merged = compressions.join('\n---\n');
  const res = await llm.call({
    messages: [
      { role: 'user', content: `${META_COMPRESSION_PROMPT}\n\n${merged}` },
    ],
  });
  return [responseText(res)];
}

// ─── 单 claw 处理 ─────────────────────────────────────────────

async function runDeepDreamForClaw(
  clawId: string,
  clawDir: string,
  llm: LLMService,
  maxCompressionTokens: number,
  fileSystem: FileSystem,
): Promise<void> {
  const today = new Date().toLocaleDateString('sv');   // ← 统一在此计算
  const state = loadDreamState(clawDir);
  const sessionFiles = discoverUnprocessed(clawDir, state, today);  // ← 传入 today

  if (sessionFiles.length === 0) {
    console.log(`[cron:deep-dream] ${clawId}: nothing to process`);
    return;
  }

  console.log(`[cron:deep-dream] ${clawId}: processing ${sessionFiles.length} session(s)`);

  let compressions: string[] = [];
  const dreamOutputs: string[] = [];
  const processedArchives: string[] = [];

  for (const sf of sessionFiles) {
    // 读取并序列化会话
    let sessionData: { messages: Message[] };
    try {
      sessionData = JSON.parse(fs.readFileSync(sf.filePath, 'utf-8'));
    } catch {
      console.warn(`[cron:deep-dream] ${clawId}: failed to read ${sf.filename}, skipping`);
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
        system: DEEP_DREAM_SYSTEM_PROMPT,
        messages: [userMsg],
      });
      dreamOutput = responseText(res);
    } catch (err) {
      console.error(`[cron:deep-dream] ${clawId}: Call 1 failed for ${sf.filename}:`, err);
      continue;
    }

    dreamOutputs.push(`### ${sf.filename}\n\n${dreamOutput}`);

    // Call 2：压缩
    let compression: string;
    try {
      const res = await llm.call({
        messages: [
          userMsg,
          { role: 'assistant', content: dreamOutput },
          { role: 'user', content: COMPRESSION_PROMPT },
        ],
      });
      compression = responseText(res);
    } catch (err) {
      console.error(`[cron:deep-dream] ${clawId}: Call 2 failed for ${sf.filename}:`, err);
      // 压缩失败不阻断流程，截取前 4000 chars 防 meta-compression 超上下文
      compression = dreamOutput.slice(0, 4000);
    }

    compressions.push(compression);
    compressions = await maybeMergeCompressions(compressions, maxCompressionTokens, llm);

    if (sf.filename !== 'current.json') {
      processedArchives.push(sf.filename);
    }
  }

  // 更新 state（无论是否有梦境输出，都记录已处理的 archive 文件）
  if (processedArchives.length > 0 || sessionFiles.some(f => f.filename === 'current.json')) {
    const updatedState: DreamStateData = {
      processedArchives: [...new Set([...state.processedArchives, ...processedArchives])],
      currentSessionDreamedDate: sessionFiles.some(f => f.filename === 'current.json')
        ? today
        : state.currentSessionDreamedDate,
    };
    saveDreamState(clawDir, updatedState);
  }

  if (dreamOutputs.length === 0) return;

  // 投递到 claw inbox
  writeInboxMessage(fileSystem, {
    inboxDir: path.join(clawDir, 'inbox', 'pending'),
    type: 'deep_dream',
    source: 'cron:dream',
    priority: 'low',
    body: dreamOutputs.join('\n\n---\n\n'),
    idPrefix: `${Date.now()}_deep_dream`,
    filenameTag: 'deep_dream',
    extraFields: { session_count: String(dreamOutputs.length) },
  });

  console.log(`[cron:deep-dream] ${clawId}: done, ${dreamOutputs.length} dream(s) sent`);
}

// ─── 主函数 ───────────────────────────────────────────────────

export async function runDeepDream(opts: DeepDreamOptions): Promise<void> {
  const maxCompressionTokens = opts.maxCompressionTokens ?? 4000;
  const clawsDir = path.join(opts.clawforumDir, 'claws');
  if (!fs.existsSync(clawsDir)) return;

  const clawIds = fs.readdirSync(clawsDir).filter(id =>
    fs.statSync(path.join(clawsDir, id)).isDirectory()
  );

  if (clawIds.length === 0) return;

  const llm = new LLMService(opts.llmConfig);

  try {
    // 串行处理每个 claw
    for (const clawId of clawIds) {
      const clawDir = path.join(clawsDir, clawId);
      try {
        await runDeepDreamForClaw(clawId, clawDir, llm, maxCompressionTokens, opts.fs);
      } catch (err) {
        console.error(`[cron:deep-dream] ${clawId}: unexpected error:`, err);
        // 单 claw 失败不阻断其他 claw
      }
    }
  } finally {
    await llm.close();
  }
}
