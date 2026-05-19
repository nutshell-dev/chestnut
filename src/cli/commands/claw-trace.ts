/**
 * @module L6.CLI.Claw.Trace
 * Claw contract trace command + 6 internal helpers
 *
 * 自治 sub-module / 6 helper 仅 trace command 内部用 / 0 跨 command 共享
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import {
  loadGlobalConfig, clawExists, getClawDir,
} from '../../foundation/config/index.js';
import { CONFIG_DEFAULTS } from '../../assembly/config-defaults.js';
import { CliError } from '../errors.js';
import { CONTRACT_DIR } from '../../core/contract/index.js';
import { DIALOG_DIR } from '../../types/paths.js';
import { migrateAndValidateSession, validateSessionData } from '../../foundation/dialog-store/store.js';

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
  clawId: string,
  contractId: string,
  step?: number,
): Promise<void> {
  loadGlobalConfig(CONFIG_DEFAULTS);

  if (!clawExists(clawId)) {
    throw new CliError(`Claw "${clawId}" does not exist`);
  }

  const clawDir = getClawDir(clawId);

  // 1. 读取 started_at
  const startedAt = await readContractStartedAt(clawDir, contractId);
  if (!startedAt) {
    throw new CliError(`Contract "${contractId}" not found for claw "${clawId}"`);
  }

  // 2. 扫描并过滤 stream 文件
  const events = await readStreamEvents(clawDir, startedAt);

  // 3. 读取契约标题
  const title = await readContractTitle(clawDir, contractId);

  if (step !== undefined) {
    // 单步全量输出
    await showStepDetail(clawDir, events, step);
  } else {
    // 概览输出
    showTraceOverview(clawId, contractId, title, startedAt, events);
  }
}

// ============================================================================
// Internal helpers (6 / cohesive sub-module / 0 export)
// ============================================================================

/**
 * 读取契约开始时间
 */
async function readContractStartedAt(clawDir: string, contractId: string): Promise<string | null> {
  // 先尝试 archive
  const archivePath = path.join(clawDir, CONTRACT_DIR, 'archive', contractId, 'progress.json');
  const activePath = path.join(clawDir, CONTRACT_DIR, 'active', contractId, 'progress.json');

  for (const p of [archivePath, activePath]) {
    try {
      const content = await fs.promises.readFile(p, 'utf-8');
      const data = JSON.parse(content);
      if (data.started_at) return data.started_at;
    } catch { /* skip */ }
  }
  return null;
}

/**
 * 读取契约标题
 */
async function readContractTitle(clawDir: string, contractId: string): Promise<string | undefined> {
  // 从 progress.json 读取
  const archivePath = path.join(clawDir, CONTRACT_DIR, 'archive', contractId, 'progress.json');
  const activePath = path.join(clawDir, CONTRACT_DIR, 'active', contractId, 'progress.json');

  for (const p of [archivePath, activePath]) {
    try {
      const content = await fs.promises.readFile(p, 'utf-8');
      const data = JSON.parse(content);
      if (data.title) return data.title;
    } catch { /* skip */ }
  }

  // 从 contract.yaml 读取
  const yamlPath = path.join(clawDir, CONTRACT_DIR, 'archive', contractId, 'contract.yaml');
  const activeYamlPath = path.join(clawDir, CONTRACT_DIR, 'active', contractId, 'contract.yaml');

  for (const p of [yamlPath, activeYamlPath]) {
    try {
      const content = await fs.promises.readFile(p, 'utf-8');
      const data = yaml.load(content) as { title?: string };
      if (data.title) return data.title;
    } catch { /* skip */ }
  }

  return undefined;
}

/**
 * 扫描 stream*.jsonl 文件，过滤契约期间的事件
 */
async function readStreamEvents(clawDir: string, startedAt: string): Promise<StreamEvent[]> {
  const startedTs = Date.parse(startedAt);
  if (isNaN(startedTs)) {
    throw new CliError(`Invalid contract start time: "${startedAt}"`);
  }

  // 扫描所有 stream*.jsonl 文件
  const files: Array<{ path: string; mtime: number }> = [];
  try {
    const entries = await fs.promises.readdir(clawDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.startsWith('stream') || !entry.name.endsWith('.jsonl')) continue;
      const fp = path.join(clawDir, entry.name);
      const stat = await fs.promises.stat(fp);
      files.push({ path: fp, mtime: stat.mtimeMs });
    }
  } catch { return []; }

  // 按修改时间排序
  files.sort((a, b) => a.mtime - b.mtime);

  // 读取并过滤事件
  const events: StreamEvent[] = [];
  for (const { path: fp } of files) {
    try {
      const content = await fs.promises.readFile(fp, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const ev: StreamEvent = JSON.parse(line);
          if (typeof ev.ts === 'number' && ev.ts >= startedTs) {
            events.push(ev);
          }
        } catch { /* skip invalid */ }
      }
    } catch { /* skip */ }
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
  contractId: string,
  title: string | undefined,
  startedAt: string,
  events: StreamEvent[],
): void {
  // 头部信息
  const titleLine = title ? `"${title}"` : '(untitled)';
  console.log(`Contract: ${titleLine} (${contractId})`);

  const startedStr = new Date(startedAt).toLocaleString();
  const totalSteps = events.filter(e => e.type === 'tool_result').length;
  console.log(`Claw: ${clawId} | Started: ${startedStr} | Steps: ${totalSteps}`);
  console.log('');

  // 遍历事件输出
  let round = 0;
  let stepSeq = 0;
  let textBuf = '';
  let nextRoundTrigger: string | null = null;

  const flushText = () => {
    const trimmed = textBuf.trim();
    if (trimmed) {
      console.log(trimmed);
      textBuf = '';
    }
  };

  const printSeparator = () => {
    const trigger = nextRoundTrigger ? ` (${nextRoundTrigger})` : '';
    const label = `Round ${round}${trigger}`;
    const line = '─'.repeat(50);
    const pos = Math.floor((50 - label.length) / 2);
    const sep = line.slice(0, pos) + label + line.slice(pos + label.length);
    console.log(sep.slice(0, 50));
    nextRoundTrigger = null;
  };

  for (const ev of events) {
    switch (ev.type) {
      case 'llm_start': {
        flushText();
        if (round > 0) printSeparator();
        round++;
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
        // 不再用于计数，计数改为在 tool_result 时进行
        break;
      }
      case 'tool_result': {
        stepSeq++;
        const name = ev.name || 'unknown';
        const mark = ev.success === false ? ' ✗' : '';
        const summaryPart = ev.summary ? ` ${ev.summary}` : '';
        console.log(`[#${stepSeq}] ${name}:${mark}${summaryPart}`);
        break;
      }
      case 'user_notify': {
        if (ev.subtype) {
          nextRoundTrigger = ev.subtype;
        }
        break;
      }
    }
  }

  flushText();
}

/**
 * 单步全量输出
 */
async function showStepDetail(
  clawDir: string,
  events: StreamEvent[],
  targetStep: number,
): Promise<void> {
  // 第一阶段：找第 N 个 tool_result，取其 tool_use_id
  let resultCount = 0;
  let targetToolName = '';
  let targetToolUseId = '';

  for (const ev of events) {
    if (ev.type === 'tool_result') {
      resultCount++;
      if (resultCount === targetStep) {
        targetToolName = ev.name || 'unknown';
        targetToolUseId = ev.tool_use_id || '';
        break;
      }
    }
  }

  if (!targetToolName) {
    throw new CliError(`Step ${targetStep} not found`);
  }

  // 读取 dialog/current.json + 所有 archive/*.json，按 mtime 升序合并
  const dialogDir = path.join(clawDir, DIALOG_DIR);
  const archiveDir = path.join(dialogDir, 'archive');
  let messages: DialogMessage[] = [];

  // 收集所有 dialog 文件（archive 先，current 最后）
  const dialogFiles: Array<{ path: string; mtime: number }> = [];
  try {
    const archiveEntries = await fs.promises.readdir(archiveDir, { withFileTypes: true });
    for (const entry of archiveEntries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const fp = path.join(archiveDir, entry.name);
      const stat = await fs.promises.stat(fp);
      dialogFiles.push({ path: fp, mtime: stat.mtimeMs });
    }
  } catch { /* no archive dir */ }

  const currentPath = path.join(dialogDir, 'current.json');
  try {
    const stat = await fs.promises.stat(currentPath);
    dialogFiles.push({ path: currentPath, mtime: stat.mtimeMs });
  } catch { /* no current */ }

  dialogFiles.sort((a, b) => {
    const aTs = parseInt(path.basename(a.path).split('_')[0], 10);
    const bTs = parseInt(path.basename(b.path).split('_')[0], 10);
    if (isNaN(aTs) || isNaN(bTs)) return 0;
    return aTs - bTs;
  });

  for (const { path: fp } of dialogFiles) {
    try {
      const content = await fs.promises.readFile(fp, 'utf-8');
      const raw = JSON.parse(content);
      const session = migrateAndValidateSession(raw, path.basename(fp));
      if (!session) continue; // version unknown → skip
      const validated = validateSessionData(session);
      if (validated.messages.length > 0) messages.push(...validated.messages as DialogMessage[]);
    } catch { /* skip */ }
  }

  if (messages.length === 0) {
    console.log('Full content not available (dialog not found)');
    return;
  }

  // 第二阶段：在 dialog 里找对应的 tool_use block
  let targetToolUse: ToolUseBlock | null = null;
  let targetToolResult: ToolResultBlock | null = null;

  if (targetToolUseId) {
    // 新路径：按 ID 查找（精确，不受历史步骤数量影响）
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
    // 降级路径：旧 stream 文件无 tool_use_id，保留计数法
    let toolUseCount = 0;
    outer: for (const msg of messages) {
      if (msg.role !== 'assistant') continue;
      const content = msg.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (typeof block !== 'object' || block === null) continue;
        const b = block as { type?: string };
        if (b.type === 'tool_use') {
          toolUseCount++;
          if (toolUseCount === targetStep) {
            targetToolUse = block as ToolUseBlock;
            break outer;
          }
        }
      }
    }
  }

  // 输出 header（始终使用流里的名称，与 overview 一致）
  console.log(`[#${targetStep}] ${targetToolName}`);
  console.log('');

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
