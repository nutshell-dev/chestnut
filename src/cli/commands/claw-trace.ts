/**
 * @module L6.CLI.Claw.Trace
 * Claw contract trace command + 6 internal helpers
 *
 * 自治 sub-module / 6 helper 仅 trace command 内部用 / 0 跨 command 共享
 */

import * as path from 'path';
import type { FileSystem } from '../../foundation/fs/types.js';
import * as yaml from 'js-yaml';
import { loadGlobalConfig, clawExists } from '../../assembly/config-load.js';
import { getClawDir, getClawConfigPath } from '../../foundation/config/index.js';
import { CliError } from '../errors.js';
import { CONTRACT_DIR, CONTRACT_ARCHIVE_DIR, PROGRESS_FILE, CONTRACT_YAML_FILE } from '../../core/contract/index.js';
import { DIALOG_DIR, DIALOG_ARCHIVE_DIR } from '../../foundation/dialog-store/index.js';
import { migrateAndValidateSession, validateSessionData } from '../../foundation/dialog-store/store.js';
import type { ContractId } from '../../core/contract/types.js';

/** claw-trace separator console.log 输出截断 cap（防 terminal 过长）*/
const SEP_DISPLAY_CHARS = 50;

interface StreamEvent {
  ts: number;
  type: string;
  name?: string;
  success?: boolean;
  subtype?: string;
  delta?: string;
  tool_use_id?: string;
  summary?: string;
}

interface DialogMessage {
  role: string;
  content: unknown;
}

interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: unknown;
}

/**
 * Show claw execution trace for a contract
 */
export async function clawTraceCommand(
  deps: { fsFactory: (baseDir: string) => FileSystem },
  clawId: string,
  contractId: ContractId,
  step?: string,
  opts: { noHint?: boolean } = {},
): Promise<void> {
  loadGlobalConfig(deps);

  const configPath = getClawConfigPath(clawId);
  if (!clawExists(deps, configPath)) {
    throw new CliError(`Claw "${clawId}" does not exist`);
  }

  const clawDir = getClawDir(clawId);
  const fileSystem = deps.fsFactory(clawDir);

  // 1. 读取 started_at
  const startedAt = await readContractStartedAt(fileSystem, contractId);
  if (!startedAt) {
    throw new CliError(`Contract "${contractId}" not found for claw "${clawId}"`);
  }

  // 2. 扫描并过滤 stream 文件
  const events = await readStreamEvents(fileSystem, startedAt);

  // 3. 读取契约标题
  const title = await readContractTitle(fileSystem, contractId);

  if (step !== undefined) {
    // 单步全量输出
    await showStepDetail(fileSystem, events, step);
  } else {
    // 概览输出
    showTraceOverview(clawId, contractId, title, startedAt, events, opts.noHint);
  }
}

/**
 * Parse a `step` arg from `claw trace --step <n>`.
 *
 * Accepts:
 *   - `5`     → turn 5, slot a (first tool of that turn)
 *   - `5.a`   → turn 5, slot a
 *   - `5.b`   → turn 5, slot b
 *
 * Same N.x convention as `chestnut claw <name> step <n>` so the two CLI
 * surfaces share the same addressing (phase 1484 numbering coherence).
 */
function parseStepArg(raw: string): { turn: number; slotIdx: number } {
  const m = raw.match(/^(\d+)(?:\.([a-z]))?$/);
  if (!m) {
    throw new CliError(`Invalid --step value: "${raw}" (expected "N" or "N.x" form, e.g. 5 or 5.a)`);
  }
  const turn = parseInt(m[1], 10);
  const slotIdx = m[2] ? m[2].charCodeAt(0) - 97 : 0;
  return { turn, slotIdx };
}

function slotLetter(idx: number): string {
  return String.fromCharCode(97 + idx);
}

// ============================================================================
// Internal helpers (6 / cohesive sub-module / 0 export)
// ============================================================================

/**
 * 读取契约开始时间
 */
async function readContractStartedAt(fileSystem: FileSystem, contractId: ContractId): Promise<string | null> {
  // 先尝试 archive
  const archivePath = path.join(CONTRACT_ARCHIVE_DIR, contractId, PROGRESS_FILE);
  const activePath = path.join(CONTRACT_DIR, 'active', contractId, PROGRESS_FILE);

  for (const p of [archivePath, activePath]) {
    try {
      const content = await fileSystem.read(p);
      // phase 355 C3 (review-2026-06-13): 验对象 shape + started_at 字符串、否则 skip
      const raw: unknown = JSON.parse(content);
      if (typeof raw !== 'object' || raw === null) continue;
      const data = raw as { started_at?: unknown };
      if (typeof data.started_at === 'string') return data.started_at;
    } catch { /* silent: parse 失败 / 文件不存 → 尝试下一路径 */ }
  }
  return null;
}

/**
 * 读取契约标题
 */
async function readContractTitle(fileSystem: FileSystem, contractId: ContractId): Promise<string | undefined> {
  // 从 progress.json 读取
  const archivePath = path.join(CONTRACT_ARCHIVE_DIR, contractId, PROGRESS_FILE);
  const activePath = path.join(CONTRACT_DIR, 'active', contractId, PROGRESS_FILE);

  for (const p of [archivePath, activePath]) {
    try {
      const content = await fileSystem.read(p);
      // phase 355 C3: 同型守
      const raw: unknown = JSON.parse(content);
      if (typeof raw !== 'object' || raw === null) continue;
      const data = raw as { title?: unknown };
      if (typeof data.title === 'string') return data.title;
    } catch { /* silent: parse 失败 → 尝试下一路径或 yaml fallback */ }
  }

  // 从 contract.yaml 读取
  const yamlPath = path.join(CONTRACT_ARCHIVE_DIR, contractId, CONTRACT_YAML_FILE);
  const activeYamlPath = path.join(CONTRACT_DIR, 'active', contractId, CONTRACT_YAML_FILE);

  for (const p of [yamlPath, activeYamlPath]) {
    try {
      const content = await fileSystem.read(p);
      const data = yaml.load(content) as { title?: string };
      if (data.title) return data.title;
    } catch { /* silent: skip */ }
  }

  return undefined;
}

/**
 * 扫描 stream*.jsonl 文件，过滤契约期间的事件
 */
async function readStreamEvents(fileSystem: FileSystem, startedAt: string): Promise<StreamEvent[]> {
  const startedTs = Date.parse(startedAt);
  if (isNaN(startedTs)) {
    throw new CliError(`Invalid contract start time: "${startedAt}"`);
  }

  // 扫描所有 stream*.jsonl 文件
  const files: Array<{ relPath: string; mtime: number }> = [];
  try {
    const entries = await fileSystem.list('.');
    for (const entry of entries) {
      if (!entry.isFile) continue;
      if (!entry.name.startsWith('stream') || !entry.name.endsWith('.jsonl')) continue;
      const stat = await fileSystem.stat(entry.name);
      files.push({ relPath: entry.name, mtime: stat.mtime.getTime() });
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      process.stderr.write(`[trace] readdir stream dir failed: ${(e as Error).message}\n`);
    }
    return [];
  }

  // 按修改时间排序
  files.sort((a, b) => a.mtime - b.mtime);

  // 读取并过滤事件
  const events: StreamEvent[] = [];
  for (const { relPath } of files) {
    try {
      const content = await fileSystem.read(relPath);
      const lines = content.trim().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          // phase 355 C3: 验对象 + ts 字段、否则 skip 行
          const raw: unknown = JSON.parse(line);
          if (typeof raw !== 'object' || raw === null) continue;
          const ev = raw as StreamEvent;
          if (typeof ev.ts === 'number' && ev.ts >= startedTs) {
            events.push(ev);
          }
        } catch { /* silent: stream 行 corrupt → skip 单行 */ }
      }
    } catch { /* silent: skip */ }
  }

  // 按时间戳排序
  events.sort((a, b) => a.ts - b.ts);
  return events;
}

/**
 * 概览输出
 */
function showTraceOverview(
  clawId: string,
  contractId: ContractId,
  title: string | undefined,
  startedAt: string,
  events: StreamEvent[],
  noHint?: boolean,
): void {
  // 头部信息
  const titleLine = title ? `"${title}"` : '(untitled)';
  console.log(`Contract: ${titleLine} (${contractId})`);

  const startedStr = new Date(startedAt).toLocaleString();
  // phase 1484: header 用 Turns 与 steps cmd 同词、turn 数 = LLM 调用次数 = llm_start event 数
  const totalTurns = events.filter(e => e.type === 'llm_start').length;
  console.log(`Claw: ${clawId} | Started: ${startedStr} | Turns: ${totalTurns}`);
  console.log('');

  // phase 1484 numbering coherence with `claw steps` / `claw step N.x`：
  // - turn 计数 = 每次 llm_start ++
  // - 同 turn 内 tool_result 槽位 a/b/c... (重置 per llm_start)
  // - turn 标号印在该 turn 内容**之前**(不像旧实现印在之后再下文换行)
  let turn = 0;
  let slotInTurn = 0;
  let textBuf = '';
  let pendingTrigger: string | null = null;

  const flushText = () => {
    const trimmed = textBuf.trim();
    if (trimmed) {
      console.log(trimmed);
      textBuf = '';
    }
  };

  const printTurnHeader = () => {
    const trigger = pendingTrigger ? ` (${pendingTrigger})` : '';
    const label = `Turn ${turn}${trigger}`;
    const line = '─'.repeat(50);
    const pos = Math.floor((50 - label.length) / 2);
    const sep = line.slice(0, pos) + label + line.slice(pos + label.length);
    console.log(sep.slice(0, SEP_DISPLAY_CHARS));
    pendingTrigger = null;
  };

  for (const ev of events) {
    switch (ev.type) {
      case 'llm_start': {
        flushText();
        turn++;
        slotInTurn = 0;
        printTurnHeader();
        break;
      }
      case 'thinking_delta': {
        // 跳过
        break;
      }
      case 'text_delta': {
        if (ev.delta) textBuf += ev.delta;
        break;
      }
      case 'text_end': {
        flushText();
        break;
      }
      case 'tool_call': {
        // 不再用于计数；计数在 tool_result 时进行（与 dialog turn N.x 槽位对齐）
        break;
      }
      case 'tool_result': {
        const slotChar = slotLetter(slotInTurn);
        slotInTurn++;
        const name = ev.name || 'unknown';
        const mark = ev.success === false ? ' ✗' : '';
        const summaryPart = ev.summary ? ` ${ev.summary}` : '';
        console.log(`[${turn}.${slotChar}] ${name}:${mark}${summaryPart}`);
        break;
      }
      case 'user_notify': {
        // user_notify 标记影响下一 turn 的 LLM 反应、trigger 标注下一 turn header
        if (ev.subtype) {
          pendingTrigger = ev.subtype;
        }
        break;
      }
    }
  }

  flushText();

  if (!noHint && totalTurns > 0) {
    console.log('');
    console.log(`→ chestnut claw ${clawId} trace --contract ${contractId} --step <n> for full detail (n=1..${totalTurns})`);
  }
}

/**
 * 单步全量输出
 */
async function showStepDetail(
  fileSystem: FileSystem,
  events: StreamEvent[],
  rawStep: string,
): Promise<void> {
  const { turn: targetTurn, slotIdx: targetSlot } = parseStepArg(rawStep);

  // phase 1484: 找 (turn targetTurn, slot targetSlot) 对应的 tool_result.
  // 顺序扫 events、按 llm_start 进 turn、按 tool_result 进 slot.
  let curTurn = 0;
  let curSlot = 0;
  let targetToolName = '';
  let targetToolUseId = '';

  for (const ev of events) {
    if (ev.type === 'llm_start') {
      curTurn++;
      curSlot = 0;
      continue;
    }
    if (ev.type === 'tool_result' && curTurn === targetTurn) {
      if (curSlot === targetSlot) {
        targetToolName = ev.name || 'unknown';
        targetToolUseId = ev.tool_use_id || '';
        break;
      }
      curSlot++;
    }
  }

  if (!targetToolName) {
    throw new CliError(
      `Step ${targetTurn}.${slotLetter(targetSlot)} not found`,
    );
  }

  // 输出 header（与 overview 同形态 [N.x]）— 先于 dialog 查找、即使 dialog 缺失
  // 用户也能确认查询的是哪一步。
  console.log(`[${targetTurn}.${slotLetter(targetSlot)}] ${targetToolName}`);
  console.log('');

  // 读取 dialog/current.json + 所有 archive/*.json，按 mtime 升序合并
  let messages: DialogMessage[] = [];

  // 收集所有 dialog 文件（archive 先，current 最后）
  const dialogFiles: Array<{ relPath: string; mtime: number }> = [];
  try {
    const archiveEntries = await fileSystem.list(path.join(DIALOG_ARCHIVE_DIR));
    for (const entry of archiveEntries) {
      if (!entry.isFile || !entry.name.endsWith('.json')) continue;
      const relPath = path.join(DIALOG_ARCHIVE_DIR, entry.name);
      const stat = await fileSystem.stat(relPath);
      dialogFiles.push({ relPath, mtime: stat.mtime.getTime() });
    }
  } catch { /* silent: no archive dir */ }

  const currentRelPath = path.join(DIALOG_DIR, 'current.json');
  try {
    const stat = await fileSystem.stat(currentRelPath);
    dialogFiles.push({ relPath: currentRelPath, mtime: stat.mtime.getTime() });
  } catch { /* silent: no current */ }

  dialogFiles.sort((a, b) => {
    const aTs = parseInt(path.basename(a.relPath).split('_')[0], 10);
    const bTs = parseInt(path.basename(b.relPath).split('_')[0], 10);
    if (isNaN(aTs) || isNaN(bTs)) return 0;
    return aTs - bTs;
  });

  for (const { relPath } of dialogFiles) {
    try {
      const content = await fileSystem.read(relPath);
      const raw = JSON.parse(content);
      const session = migrateAndValidateSession(raw, path.basename(relPath));
      if (!session) continue; // version unknown → skip
      const validated = validateSessionData(session);
      if (validated.messages.length > 0) messages.push(...validated.messages as DialogMessage[]);
    } catch { /* silent: skip */ }
  }

  if (messages.length === 0) {
    console.log('Full content not available (dialog not found)');
    return;
  }

  // 第二阶段：在 dialog 里找对应的 tool_use block
  let targetToolUse: ToolUseBlock | null = null;
  let targetToolResult: ToolResultBlock | null = null;

  if (targetToolUseId) {
    // 主路径：按 stream 里取到的 tool_use_id 在 dialog 里精确匹配。
    outer: for (const msg of messages) {
      if (msg.role !== 'assistant') continue;
      const content = msg.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (typeof block !== 'object' || block === null) continue;
        const b = block as { type?: string; id?: string };
        if (b.type === 'tool_use' && b.id === targetToolUseId) {
          targetToolUse = block as ToolUseBlock;
          break outer;
        }
      }
    }
  } else {
    // 降级路径：旧 stream 无 tool_use_id。在 dialog 里按 (turn, slot) 同体系定位。
    let asstSeen = 0;
    outer: for (const msg of messages) {
      if (msg.role !== 'assistant') continue;
      asstSeen++;
      if (asstSeen !== targetTurn) continue;
      const content = msg.content;
      if (!Array.isArray(content)) continue;
      let slot = 0;
      for (const block of content) {
        if (typeof block !== 'object' || block === null) continue;
        const b = block as { type?: string };
        if (b.type === 'tool_use') {
          if (slot === targetSlot) {
            targetToolUse = block as ToolUseBlock;
            break outer;
          }
          slot++;
        }
      }
    }
  }

  if (!targetToolUse) {
    console.log('(Content unavailable: dialog not found)');
    return;
  }

  if (targetToolUse.name !== targetToolName) {
    // 降级计数定位到了错误的 block（老流 + 多契约 claw）
    console.log('(Content unavailable: old stream format, step lookup unreliable)');
    return;
  }

  // 找对应的 tool_result
  for (const msg of messages) {
    if (msg.role !== 'user') continue;

    const content = msg.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue;
      const b = block as { type?: string; tool_use_id?: string };
      if (b.type === 'tool_result' && b.tool_use_id === targetToolUse!.id) {
        targetToolResult = block as ToolResultBlock;
        break;
      }
    }
    if (targetToolResult) break;
  }

  // 输出
  console.log('Input:');
  console.log(JSON.stringify(targetToolUse.input, null, 2));
  console.log('');

  if (targetToolResult) {
    const streamResult = events.find(ev => ev.type === 'tool_result' && ev.tool_use_id === targetToolUseId);
    const success = streamResult ? streamResult.success !== false : true;
    console.log(`Result (${success ? 'success' : 'failed'}):`);
    console.log(formatToolResultContent(targetToolResult.content));
  } else {
    console.log('Result: (not found)');
  }
}

/**
 * 格式化 tool_result 内容
 */
function formatToolResultContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const item of content) {
      if (typeof item === 'object' && item !== null) {
        const obj = item as { type?: string; text?: string };
        if (obj.type === 'text' && obj.text) {
          texts.push(obj.text);
        }
      }
    }
    return texts.join('\n');
  }
  return JSON.stringify(content, null, 2);
}
