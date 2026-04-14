/**
 * claw command - Create and chat with Claws
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

import { 
  loadGlobalConfig, 
  loadClawConfig, 
  saveClawConfig, 
  clawExists,
  getClawDir,
  buildLLMConfig,
  getGlobalConfigPath,
  CLAW_SUBDIRS,
} from '../config.js';
import { CliError, handleCliError } from '../../utils/error.js';

import { runChatViewport } from './chat-viewport.js';
import { buildAgentsMdTemplate } from '../../prompts/index.js';

/**
 * Format relative time (milliseconds to a human-readable string)
 */
function formatRelativeTime(ms: number): string {
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return '<1m';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return `${hours}h`;
}

// LLM 输出事件类型（与 watchdog 一致）
const LLM_OUTPUT_EVENTS = new Set(['thinking_delta', 'text_delta', 'tool_call']);

/**
 * 从 stream.jsonl 读取最后活跃时间（统一与 watchdog 指标）
 */
function getLastActiveMs(clawDir: string): number | undefined {
  const streamFile = path.join(clawDir, 'dialog', 'stream.jsonl');
  try {
    const lines = fs.readFileSync(streamFile, 'utf-8').trim().split('\n').filter(Boolean);
    let last: number | undefined;
    for (const line of lines) {
      try {
        const ev = JSON.parse(line);
        if (LLM_OUTPUT_EVENTS.has(ev.type) && typeof ev.ts === 'number') {
          last = ev.ts;
        }
      } catch { /* skip */ }
    }
    return last;
  } catch { return undefined; }
}

import { ProcessManager } from '../../foundation/process-manager/index.js';
import { NodeFileSystem } from '../../foundation/fs/node-fs.js';
import { writeInbox } from '../../foundation/messaging/index.js';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { PROCESS_SPAWN_CONFIRM_MS, DEFAULT_MAX_STEPS } from '../../constants.js';

export async function createCommand(name: string): Promise<void> {
  // Load global config (ensures initialized)
  loadGlobalConfig();
  
  // Check if claw already exists
  if (clawExists(name)) {
    throw new CliError(`Claw "${name}" already exists`);
  }
  
  const clawDir = getClawDir(name);
  
  // Create directory structure (using shared constants)
  for (const dir of CLAW_SUBDIRS) {
    fs.mkdirSync(path.join(clawDir, dir), { recursive: true });
  }
  
  // Create claw config (inherits from global)
  const config = {
    name,
    max_steps: DEFAULT_MAX_STEPS,
    tool_profile: 'full' as const,
    max_concurrent_tasks: 3,
  };
  
  saveClawConfig(name, config);
  
  // Create AGENTS.md template
  const agentsMdPath = path.join(clawDir, 'AGENTS.md');
  const agentsTemplate = buildAgentsMdTemplate(name);
  fs.writeFileSync(agentsMdPath, agentsTemplate);
  
  console.log(`Created Claw "${name}"`);
  console.log(`  Location: ${clawDir}`);
  console.log(`\nNext step: clawforum claw chat ${name}`);
}

export async function chatCommand(name: string): Promise<void> {
  loadGlobalConfig();

  if (!clawExists(name)) {
    throw new CliError(`Claw "${name}" does not exist`);
  }

  const clawDir = getClawDir(name);
  const globalConfigPath = getGlobalConfigPath();
  const baseDir = path.dirname(globalConfigPath);

  const globalConfig = loadGlobalConfig();
  await runChatViewport({
    agentDir: clawDir,
    label: name,
    ensureDaemon: async () => {
      const nodeFs = new NodeFileSystem({ baseDir, enforcePermissions: false });
      const pm = new ProcessManager(nodeFs, baseDir);
      if (!pm.isAlive(name)) {
        console.log(`Starting Claw "${name}" daemon...`);
        const thisDir = path.dirname(fileURLToPath(import.meta.url));
        const daemonEntryPath = path.resolve(thisDir, '..', '..', 'daemon-entry.js');
        const pid = await pm.spawn(name, {
          command: 'node',
          args: [daemonEntryPath, name],
          logFile: path.join(clawDir, 'logs', 'daemon.log'),
          env: { ...process.env, CLAWFORUM_ROOT: process.env.CLAWFORUM_ROOT ?? process.cwd() } as Record<string, string | undefined>,
        });
        console.log(`Started (PID: ${pid})`);
        // Wait for daemon to initialize
        await new Promise(resolve => setTimeout(resolve, PROCESS_SPAWN_CONFIRM_MS));
      }
    },
    showRecapStream: globalConfig.viewport?.show_recap_stream,
    showSystemMessages: globalConfig.viewport?.show_system_messages,
    showContractEvents: globalConfig.viewport?.show_contract_events,
    trimOutputNewlines: globalConfig.viewport?.trim_output_newlines,
  });
}

// ============================================================================
// Daemon Management Commands
// ============================================================================

/**
 * Stop the Claw daemon process
 */
export async function stopCommand(name: string): Promise<void> {
  loadGlobalConfig();
  
  if (!clawExists(name)) {
    throw new CliError(`Claw "${name}" does not exist`);
  }

  const globalConfigPath = getGlobalConfigPath();
  const baseDir = path.dirname(globalConfigPath);
  
  const nodeFs = new NodeFileSystem({ baseDir, enforcePermissions: false });
  const processManager = new ProcessManager(nodeFs, baseDir);

  // Check if running
  if (!processManager.isAlive(name)) {
    console.log(`Claw "${name}" is not running`);
    return;
  }

  console.log(`Stopping Claw "${name}"...`);
  
  const success = await processManager.stop(name);
  if (success) {
    console.log(`Stopped Claw "${name}"`);
  } else {
    throw new CliError(`Failed to stop Claw "${name}"`);
  }
}

/**
 * List all Claws and their status
 */
export async function listCommand(): Promise<void> {
  loadGlobalConfig();

  const globalConfigPath = getGlobalConfigPath();
  const baseDir = path.dirname(globalConfigPath);
  const clawsDir = path.join(baseDir, 'claws');

  const nodeFs = new NodeFileSystem({ baseDir, enforcePermissions: false });
  const processManager = new ProcessManager(nodeFs, baseDir);

  // Helper: check contract status
  function getContractStatus(clawPath: string): string {
    for (const sub of ['active', 'paused']) {
      try {
        const entries = fs.readdirSync(path.join(clawPath, 'contract', sub), { withFileTypes: true });
        if (entries.some(e => e.isDirectory())) return sub;
      } catch { /* skip */ }
    }
    return '-';
  }

  // Helper: count unread outbox messages
  function getOutboxCount(clawPath: string): number {
    try {
      return fs.readdirSync(path.join(clawPath, 'outbox', 'pending')).length;
    } catch { return 0; }
  }

  // Helper: format relative last-active time
  function formatLastActive(clawPath: string): string {
    const ms = getLastActiveMs(clawPath);
    if (ms === undefined) return '-';
    const age = Date.now() - ms;
    const mins = Math.floor(age / 60000);
    if (mins < 1) return '<1m';
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    return `${hours}h`;
  }

  // Helper: get latest contract title (active > paused > most recent archive)
  function getLatestContractTitle(clawPath: string): string {
    for (const sub of ['active', 'paused']) {
      try {
        const dirs = fs.readdirSync(path.join(clawPath, 'contract', sub));
        for (const dir of dirs) {
          const yamlPath = path.join(clawPath, 'contract', sub, dir, 'contract.yaml');
          if (fs.existsSync(yamlPath)) {
            const content = fs.readFileSync(yamlPath, 'utf-8');
            const match = content.match(/^title:\s*["']?(.+?)["']?\s*$/m);
            if (match) return match[1].slice(0, 28);
          }
        }
      } catch { /* skip */ }
    }
    try {
      const archiveDir = path.join(clawPath, 'contract', 'archive');
      const dirs = fs.readdirSync(archiveDir);
      let latest = { mtime: 0, title: '' };
      for (const dir of dirs) {
        const yamlPath = path.join(archiveDir, dir, 'contract.yaml');
        if (fs.existsSync(yamlPath)) {
          const stat = fs.statSync(yamlPath);
          if (stat.mtimeMs > latest.mtime) {
            const content = fs.readFileSync(yamlPath, 'utf-8');
            const match = content.match(/^title:\s*["']?(.+?)["']?\s*$/m);
            if (match) latest = { mtime: stat.mtimeMs, title: match[1].slice(0, 28) };
          }
        }
      }
      if (latest.title) return latest.title;
    } catch { /* skip */ }
    return '-';
  }

  try {
    // Ensure claws directory exists
    if (!fs.existsSync(clawsDir)) {
      fs.mkdirSync(clawsDir, { recursive: true });
    }
    const entries = fs.readdirSync(clawsDir);
    const claws: Array<{
      name: string;
      status: string;
      pid?: string;
      contract: string;
      outbox: number;
      lastActive: string;
      lastContract: string;
    }> = [];

    for (const entry of entries) {
      const clawPath = path.join(clawsDir, entry);
      const configPath = path.join(clawPath, 'config.yaml');
      if (fs.existsSync(configPath)) {
        const isRunning = processManager.isAlive(entry);
        let pid: string | undefined;

        if (isRunning) {
          try {
            const pidFile = path.join(clawPath, 'status', 'pid');
            pid = fs.readFileSync(pidFile, 'utf-8').trim();
          } catch { /* ignore read errors */ }
        }

        claws.push({
          name: entry,
          status: isRunning ? 'running' : 'stopped',
          pid,
          contract: getContractStatus(clawPath),
          outbox: getOutboxCount(clawPath),
          lastActive: formatLastActive(clawPath),
          lastContract: getLatestContractTitle(clawPath),
        });
      }
    }

    if (claws.length === 0) {
      console.log('No claws found. Create one with: clawforum claw create <name>');
      return;
    }

    // Print table
    console.log('\nClaw List:');
    console.log('─'.repeat(112));
    console.log(`${'Name'.padEnd(20)} ${'Status'.padEnd(12)} ${'PID'.padEnd(10)} ${'Contract'.padEnd(10)} ${'Outbox'.padEnd(8)} ${'LastActive'.padEnd(10)} ${'Last Contract'.padEnd(30)}`);
    console.log('─'.repeat(112));

    for (const claw of claws) {
      const statusIcon = claw.status === 'running' ? '[running]' : '[stopped]';
      const pidStr = claw.pid || '-';
      console.log(`${claw.name.padEnd(20)} ${statusIcon.padEnd(12)} ${pidStr.padEnd(10)} ${claw.contract.padEnd(10)} ${String(claw.outbox).padEnd(8)} ${claw.lastActive.padEnd(10)} ${claw.lastContract.padEnd(30)}`);
    }

    console.log('─'.repeat(112));
    console.log(`\nTotal: ${claws.length} claws (${claws.filter(c => c.status === 'running').length} running)\n`);
  } catch (error) {
    console.error('Failed to list claws:', error instanceof Error ? error.message : String(error));
    process.exitCode = handleCliError(error);
  }
}

/**
 * Display Claw health status (reads directory in real time)
 */
export async function healthCommand(name: string): Promise<void> {
  loadGlobalConfig();

  if (!clawExists(name)) {
    throw new CliError(`Claw "${name}" does not exist`);
  }

  const clawDir = getClawDir(name);
  const globalConfigPath = getGlobalConfigPath();
  const baseDir = path.dirname(globalConfigPath);

  const nodeFs = new NodeFileSystem({ baseDir, enforcePermissions: false });
  const processManager = new ProcessManager(nodeFs, baseDir);

  const isRunning = processManager.isAlive(name);

  // Read inbox/outbox pending counts in real time
  let inboxPending = 0;
  let outboxPending = 0;
  try {
    const entries = fs.readdirSync(path.join(clawDir, 'inbox', 'pending'));
    inboxPending = entries.length;
  } catch { /* directory does not exist */ }
  try {
    const entries = fs.readdirSync(path.join(clawDir, 'outbox', 'pending'));
    outboxPending = entries.length;
  } catch { /* directory does not exist */ }

  // Check contract status
  let contractStatus = 'none';
  for (const sub of ['active', 'paused']) {
    try {
      const entries = fs.readdirSync(
        path.join(clawDir, 'contract', sub), { withFileTypes: true }
      );
      if (entries.some(e => e.isDirectory())) {
        contractStatus = sub;
        break;
      }
    } catch { /* skip */ }
  }

  // Last active time（统一使用 stream.jsonl 指标）
  let lastActive = '-';
  const lastMs = getLastActiveMs(clawDir);
  if (lastMs !== undefined) {
    lastActive = formatRelativeTime(Date.now() - lastMs);
  }

  console.log(`\nHealth Check: ${name}`);
  console.log('─'.repeat(40));
  console.log(`status: ${isRunning ? 'running' : 'stopped'}`);
  console.log(`inbox_pending: ${inboxPending}`);
  console.log(`outbox_pending: ${outboxPending}`);
  console.log(`contract: ${contractStatus}`);
  console.log(`last_active: ${lastActive}`);
  console.log(`as_of: ${new Date().toISOString()}`);
}

// ============================================================================
// Send Message Command
// ============================================================================

/**
 * Send an inbox message to a Claw
 */
export async function sendCommand(
  name: string, 
  message: string, 
  options?: { priority?: 'critical' | 'high' | 'normal' | 'low' }
): Promise<void> {
  loadGlobalConfig();
  
  if (!clawExists(name)) {
    throw new CliError(`Claw "${name}" does not exist`);
  }

  const globalConfigPath = getGlobalConfigPath();
  const baseDir = path.dirname(globalConfigPath);
  const clawDir = path.join(baseDir, 'claws', name);
  const inboxPending = path.join(clawDir, 'inbox', 'pending');
  const fs = new NodeFileSystem({ baseDir: '/', enforcePermissions: false });

  await writeInbox(fs, inboxPending, {
    id: randomUUID(),
    type: 'user_inbox_message',
    from: 'user',
    to: name,
    content: message,
    priority: options?.priority ?? 'normal',
    timestamp: new Date().toISOString(),
  });

  console.log(`Message sent to "${name}"`);
}

// ============================================================================
// Outbox Command
// ============================================================================

/**
 * Read and consume Claw outbox messages
 */
export async function outboxCommand(
  name: string,
  options?: { limit?: number }
): Promise<void> {
  loadGlobalConfig();

  if (!clawExists(name)) {
    throw new CliError(`Claw "${name}" does not exist`);
  }

  const clawDir = getClawDir(name);
  const pendingDir = path.join(clawDir, 'outbox', 'pending');
  const doneDir = path.join(clawDir, 'outbox', 'done');

  // Read pending files
  let files: string[] = [];
  try {
    const allFiles = await fs.promises.readdir(pendingDir);
    files = allFiles.filter(f => f.endsWith('.md')).sort();
  } catch {
    console.log('outbox is empty');
    return;
  }

  if (files.length === 0) {
    console.log('outbox is empty');
    return;
  }

  // Limit number of messages read (default 1)
  const limit = options?.limit ?? 1;
  const toRead = files.slice(0, limit);
  const remaining = files.length - toRead.length;

  // Read and output
  const results: string[] = [];
  for (const fileName of toRead) {
    const filePath = path.join(pendingDir, fileName);
    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      results.push(content);

      // Move to done/
      try {
        await fs.promises.mkdir(doneDir, { recursive: true });
        await fs.promises.rename(filePath, path.join(doneDir, `${Date.now()}_${fileName}`));
      } catch (err) {
        console.warn(`[outbox] Failed to move ${fileName} to done: ${err instanceof Error ? err.message : String(err)}`);
      }
    } catch {
      // skip on read failure
    }
  }

  // Output
  for (const content of results) {
    console.log(content);
    console.log('---');
  }

  if (remaining > 0) {
    console.log(`(${remaining} more unread message(s))`);
  }
}

// ============================================================================
// Trace Command - Show claw execution trace for a contract
// ============================================================================

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
  loadGlobalConfig();

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

/**
 * 读取契约开始时间
 */
async function readContractStartedAt(clawDir: string, contractId: string): Promise<string | null> {
  // 先尝试 archive
  const archivePath = path.join(clawDir, 'contract', 'archive', contractId, 'progress.json');
  const activePath = path.join(clawDir, 'contract', 'active', contractId, 'progress.json');

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
  const archivePath = path.join(clawDir, 'contract', 'archive', contractId, 'progress.json');
  const activePath = path.join(clawDir, 'contract', 'active', contractId, 'progress.json');

  for (const p of [archivePath, activePath]) {
    try {
      const content = await fs.promises.readFile(p, 'utf-8');
      const data = JSON.parse(content);
      if (data.title) return data.title;
    } catch { /* skip */ }
  }

  // 从 contract.yaml 读取
  const yamlPath = path.join(clawDir, 'contract', 'archive', contractId, 'contract.yaml');
  const activeYamlPath = path.join(clawDir, 'contract', 'active', contractId, 'contract.yaml');

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
    throw new Error(`Invalid contract start time: "${startedAt}"`);
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
  const dialogDir = path.join(clawDir, 'dialog');
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

  dialogFiles.sort((a, b) => a.mtime - b.mtime);

  for (const { path: fp } of dialogFiles) {
    try {
      const content = await fs.promises.readFile(fp, 'utf-8');
      const data = JSON.parse(content);
      const msgs: DialogMessage[] = Array.isArray(data) ? data
        : (Array.isArray(data.messages) ? data.messages : []);
      if (msgs.length > 0) messages.push(...msgs);
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
