import * as path from 'path';
import { FileNotFoundError } from '../../types/errors.js';
import type { FileSystem } from '../../foundation/fs/types.js';
import { MEMORY_AUDIT_EVENTS } from './audit-events.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { AsyncTaskSystem } from '../async-task-system/system.js';
import { TOOL_PROFILES } from '../../foundation/tools/index.js';
import { InboxWriter } from '../../foundation/messaging/index.js';
import { createSystemAudit } from '../../foundation/audit/index.js';
import { DEFAULT_LLM_IDLE_TIMEOUT_MS } from '../../foundation/llm-orchestrator/index.js';
import { CONTRACT_DIR } from '../contract/index.js';
import { CLAWS_DIR } from '../../types/paths.js';
import {
  RANDOM_DREAM_SYSTEM_PROMPT,
  buildRandomDreamPrompt,
} from './prompts/random-dream.js';

const DEFAULT_RANDOM_DREAM_TIMEOUT_MS = 3600 * 1000;  // 1h
const DEFAULT_RANDOM_DREAM_MAX_STEPS = 200;

// ─── 类型定义 ────────────────────────────────────────────────

export interface RandomDreamOptions {
  clawforumDir: string;
  motionDir: string;
  taskSystem: AsyncTaskSystem;
  fs: FileSystem;             // baseDir = clawforumDir
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
  signal?: AbortSignal;
}

interface WeightedContract {
  clawId: string;
  contractId: string;
  contractDir: string;
  weight: number;
  hint: string;
}

interface RandomDreamState {
  processedContractIds: string[];
}

// ─── Random Dream State I/O ──────────────────────────────────

const RANDOM_DREAM_STATE_FILE = '.random-dream-state.json';

function loadRandomDreamState(fs: FileSystem, audit: AuditLog): RandomDreamState {
  try {
    return JSON.parse(
      fs.readSync(RANDOM_DREAM_STATE_FILE)
    ) as RandomDreamState;
  } catch (err) {
    // FileNotFoundError 首启良性 / silent
    if (err instanceof FileNotFoundError) {
      return { processedContractIds: [] };
    }
    // 其他 IO 错（parse 损坏 / 权限 / 等）必 audit + 返空 resilient
    audit.write(MEMORY_AUDIT_EVENTS.RANDOM_DREAM_ERROR,
      `step=load_state`,
      `reason=${err instanceof Error ? err.message : String(err)}`,
    );
    return { processedContractIds: [] };
  }
}

function saveRandomDreamState(fs: FileSystem, state: RandomDreamState, audit: AuditLog): void {
  try {
    fs.writeAtomicSync(
      RANDOM_DREAM_STATE_FILE,
      JSON.stringify(state, null, 2)
    );
  } catch (err) {
    audit.write(MEMORY_AUDIT_EVENTS.RANDOM_DREAM_ERROR,
      `step=save_state`,
      `reason=${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;   // re-throw 保 caller flow（cron runner phase 552 late_error 路径捕获）
  }
}

// ─── 契约发现与权重计算 ──────────────────────────────────────

interface ProgressData {
  subtasks: Record<string, {
    status: string;
    completed_at?: string;
    retry_count?: number;
  }>;
  started_at?: string;
}

/** 计算契约权重（越高越优先） */
function computeWeight(
  fs: FileSystem,
  contractId: string,
  contractDir: string,
  clawId: string,
  processedIds: Set<string>,
  clawsSeen: Set<string>,     // 本次已选中的 clawId 集合
): { weight: number; hint: string } {
  let weight = 10;
  const hints: string[] = [];

  // 已被处理过：大幅降权
  if (processedIds.has(contractId)) {
    weight -= 80;
    hints.push('已处理');
  }

  // 不同 claw 优先
  if (!clawsSeen.has(clawId)) {
    weight += 30;
    hints.push('新claw');
  }

  // 近期完成：读 progress.json 中各 subtask 的 completed_at
  const progressPath = path.join(contractDir, 'progress.json');
  try {
    const progress = JSON.parse(fs.readSync(progressPath)) as ProgressData;
    const subtasks = Object.values(progress.subtasks ?? {});

    // 近期完成加权（7 天内权重最高）
    const completedAts = subtasks
      .map(s => s.completed_at ? new Date(s.completed_at).getTime() : 0)
      .filter(t => t > 0);
    if (completedAts.length > 0) {
      const latestMs = Math.max(...completedAts);
      const daysAgo = (Date.now() - latestMs) / (1000 * 60 * 60 * 24);
      const recencyBonus = Math.round(50 * Math.exp(-daysAgo / 7));
      weight += recencyBonus;
      if (recencyBonus > 20) hints.push('近期完成');
    }

    // 失败/困难加权
    let difficultyBonus = 0;
    for (const s of subtasks) {
      if (s.status === 'failed') difficultyBonus += 20;
      else if ((s.retry_count ?? 0) >= 2) difficultyBonus += 10;
    }
    weight += difficultyBonus;
    if (difficultyBonus > 0) hints.push('执行困难');
  } catch { /* 无 progress.json，跳过 */ }

  // 权重下限 1
  weight = Math.max(1, weight);
  return { weight, hint: hints.join('、') || '正常' };
}

function discoverWeightedContracts(
  fs: FileSystem,
  state: RandomDreamState,
): WeightedContract[] {
  if (!fs.existsSync(CLAWS_DIR)) return [];

  const processedIds = new Set(state.processedContractIds);
  const clawsSeen = new Set<string>();
  const contracts: WeightedContract[] = [];

  for (const e of fs.listSync(CLAWS_DIR, { includeDirs: true })) {
    const clawId = e.name;
    const archiveDir = path.join(CLAWS_DIR, clawId, CONTRACT_DIR, 'archive');
    if (!fs.existsSync(archiveDir)) continue;

    for (const ce of fs.listSync(archiveDir, { includeDirs: true })) {
      const contractId = ce.name;
      const contractDir = path.join(archiveDir, contractId);
      if (!fs.statSync(contractDir).isDirectory) continue;

      const { weight, hint } = computeWeight(fs, contractId, contractDir, clawId, processedIds, clawsSeen);
      contracts.push({ clawId, contractId, contractDir, weight, hint });
      clawsSeen.add(clawId);  // NEW phase 585 / 每 claw 首契约获 +30 bonus / 后续不获
    }
    // clawsSeen 内层每契约后 add（首契约获 +30 bonus）/ firstSeenClaws 排序后 hint 文案独立修正
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

// ─── 等待任务结果 ────────────────────────────────────────────

export async function waitForTaskResult(
  motionFs: FileSystem,
  taskId: string,
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
        return motionFs.readSync(logPath);
      }
      // .log 不存在（极端情况），降级读 .txt
      return motionFs.readSync(donePath);
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

  audit?.write(MEMORY_AUDIT_EVENTS.RANDOM_DREAM_WARNING, `reason=poll_timeout`, `taskId=${taskId}`);
  console.warn(`[cron:random-dream] timeout waiting for task ${taskId}`);
  return null;
}

// ─── 结果解析 ────────────────────────────────────────────────

interface DreamExtractionResult {
  outputs: string[];
  contractIds: string[];
}

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
  const state = loadRandomDreamState(opts.fs, opts.audit);
  const weightedContracts = discoverWeightedContracts(opts.fs, state);

  if (weightedContracts.length === 0) {
    opts.audit.write(MEMORY_AUDIT_EVENTS.RANDOM_DREAM_JOB, `step=skip_empty`);
    return;
  }

  opts.audit.write(MEMORY_AUDIT_EVENTS.RANDOM_DREAM_JOB, `step=scheduled`, `count=${weightedContracts.length}`);

  // 调度 sub-agent（文件驱动，watcher 异步拾起）
  const motionAudit = createSystemAudit(opts.fs, opts.motionDir);
  const subagentTimeoutMs = opts.subagentTimeoutMs ?? DEFAULT_RANDOM_DREAM_TIMEOUT_MS;
  const subagentMaxSteps = opts.subagentMaxSteps ?? DEFAULT_RANDOM_DREAM_MAX_STEPS;

  const taskId = await opts.taskSystem.writePendingSubAgentTask(motionAudit, {
    kind: 'subagent',
    intent: buildRandomDreamPrompt(weightedContracts),
    timeoutMs: subagentTimeoutMs,
    maxSteps: subagentMaxSteps,
    parentClawId: 'motion',
    originClawId: 'motion',
    systemPrompt: RANDOM_DREAM_SYSTEM_PROMPT,    // phase 546: dead import 活化（同 deep-dream 直 LLMService.call 模板 align）
  });

  opts.audit.write(MEMORY_AUDIT_EVENTS.RANDOM_DREAM_JOB, `step=subagent_started`, `taskId=${taskId}`);

  // 等待完成（最长 1h，每 30s 轮询）
  const log = await waitForTaskResult(
    opts.motionFs,
    taskId,
    subagentTimeoutMs,
    opts.pulseIntervalMs ?? 30_000,
    opts.audit,
    opts.pulseAuditEnabled ?? false,
    opts.signal,
  );
  if (!log) {
    opts.audit.write(
      MEMORY_AUDIT_EVENTS.RANDOM_DREAM_WARNING,
      `reason=subagent_timeout`,
      `taskId=${taskId}`,  // NEW phase 758 / 让事后 grep result.txt 关联
    );
    console.warn(`[cron:random-dream] sub-agent did not complete within timeout (taskId=${taskId})`);
    return;
  }

  // 解析梦境输出
  const { outputs, contractIds } = extractDreamOutputs(log);
  if (outputs.length === 0) {
    opts.audit.write(MEMORY_AUDIT_EVENTS.RANDOM_DREAM_WARNING, `reason=no_output`);
    console.warn('[cron:random-dream] no [DREAM_OUTPUT] blocks found in log');
    return;
  }

  opts.audit.write(MEMORY_AUDIT_EVENTS.RANDOM_DREAM_JOB, `step=finished`, `output_count=${outputs.length}`);

  // 更新 state
  const updatedState: RandomDreamState = {
    processedContractIds: [
      ...new Set([...state.processedContractIds, ...contractIds]),
    ],
  };
  saveRandomDreamState(opts.fs, updatedState, opts.audit);

  const dreamOutput = outputs.join('\n\n---\n\n');
  const dreamOutputPath = `memory/dream-outputs/${taskId}.txt`;

  // NEW: disk snapshot（motion 域）
  await opts.motionFs.ensureDir('memory/dream-outputs');
  await opts.motionFs.writeAtomic(dreamOutputPath, dreamOutput);
  opts.audit.write(
    MEMORY_AUDIT_EVENTS.DREAM_OUTPUT_PERSISTED,
    `dreamId=${taskId}`,
    `path=${dreamOutputPath}`,
    `bytes=${dreamOutput.length}`,
  );

  // 投递到 motion inbox（motionAudit 已在调度前实例化，直接复用）
  new InboxWriter(opts.fs, path.join(opts.motionDir, 'inbox', 'pending'), motionAudit).writeSync({
    type: 'random_dream',
    source: 'cron:dream',
    priority: 'low',
    body: dreamOutput,
    idPrefix: `${Date.now()}_random_dream`,
    filenameTag: 'random_dream',
    extraFields: { dream_count: String(outputs.length) },
  });
}
