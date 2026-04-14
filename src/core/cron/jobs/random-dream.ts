import * as fs from 'fs';
import * as path from 'path';
import type { TaskSystem } from '../../task/system.js';
import { scheduleSubAgentWithTracking } from '../../tools/builtins/spawn.js';
import { TOOL_PROFILES } from '../../tools/profiles.js';
import { writeInboxMessage } from '../../../utils/inbox-writer.js';
import {
  RANDOM_DREAM_SYSTEM_PROMPT,
  buildRandomDreamPrompt,
} from '../../../prompts/random-dream.js';
import type { StreamSink } from '../../../foundation/stream/types.js';

// ─── 类型定义 ────────────────────────────────────────────────

export interface RandomDreamOptions {
  clawforumDir: string;
  motionDir: string;
  taskSystem: TaskSystem;
  streamWriter: StreamSink;
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

function randomDreamStatePath(clawforumDir: string): string {
  return path.join(clawforumDir, '.random-dream-state.json');
}

function loadRandomDreamState(clawforumDir: string): RandomDreamState {
  try {
    return JSON.parse(
      fs.readFileSync(randomDreamStatePath(clawforumDir), 'utf-8')
    ) as RandomDreamState;
  } catch {
    return { processedContractIds: [] };
  }
}

function saveRandomDreamState(clawforumDir: string, state: RandomDreamState): void {
  fs.writeFileSync(
    randomDreamStatePath(clawforumDir),
    JSON.stringify(state, null, 2),
    'utf-8'
  );
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
    const progress = JSON.parse(fs.readFileSync(progressPath, 'utf-8')) as ProgressData;
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
  clawforumDir: string,
  state: RandomDreamState,
): WeightedContract[] {
  const clawsDir = path.join(clawforumDir, 'claws');
  if (!fs.existsSync(clawsDir)) return [];

  const processedIds = new Set(state.processedContractIds);
  const clawsSeen = new Set<string>();
  const contracts: WeightedContract[] = [];

  for (const clawId of fs.readdirSync(clawsDir)) {
    const archiveDir = path.join(clawsDir, clawId, 'contract', 'archive');
    if (!fs.existsSync(archiveDir)) continue;

    for (const contractId of fs.readdirSync(archiveDir)) {
      const contractDir = path.join(archiveDir, contractId);
      if (!fs.statSync(contractDir).isDirectory()) continue;

      const { weight, hint } = computeWeight(contractId, contractDir, clawId, processedIds, clawsSeen);
      contracts.push({ clawId, contractId, contractDir, weight, hint });
    }
    // 注意：clawsSeen 在排序后才有意义，这里先收集全部，排序时更新
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

async function waitForTaskResult(
  motionDir: string,
  taskId: string,
  timeoutMs: number,
  pollIntervalMs = 30_000,
): Promise<string | null> {
  // .txt 由 TaskSystem.sendResult 在 subAgent.run() 完成后写入，是可靠的完成信号
  const donePath = path.join(motionDir, 'tasks', 'results', taskId, 'result.txt');
  // [DREAM_OUTPUT] 块由 appendToLog 写入 .log
  const logPath  = path.join(motionDir, 'tasks', 'results', taskId, 'daemon.log');
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (fs.existsSync(donePath)) {
      // 完成信号出现，读取日志内容
      if (fs.existsSync(logPath)) {
        return fs.readFileSync(logPath, 'utf-8');
      }
      // .log 不存在（极端情况），降级读 .txt
      return fs.readFileSync(donePath, 'utf-8');
    }
    await new Promise(r => setTimeout(r, pollIntervalMs));
  }

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

export async function runRandomDream(opts: RandomDreamOptions): Promise<void> {
  const state = loadRandomDreamState(opts.clawforumDir);
  const weightedContracts = discoverWeightedContracts(opts.clawforumDir, state);

  if (weightedContracts.length === 0) {
    console.log('[cron:random-dream] no archived contracts found, skipping');
    return;
  }

  console.log(`[cron:random-dream] scheduling sub-agent for ${weightedContracts.length} contracts`);

  // 调度 sub-agent
  const taskId = await scheduleSubAgentWithTracking(opts.taskSystem, opts.streamWriter, {
    prompt: buildRandomDreamPrompt(weightedContracts),
    tools: TOOL_PROFILES['dream'],
    parentClawId: 'motion',
    originClawId: 'motion',
    systemPrompt: RANDOM_DREAM_SYSTEM_PROMPT,
    silent: true,
    maxSteps: 200,
    timeout: 3600,
  });

  console.log(`[cron:random-dream] sub-agent started, taskId=${taskId}, waiting (up to 1h)...`);

  // 等待完成（最长 1h，每 30s 轮询）
  const log = await waitForTaskResult(opts.motionDir, taskId, 3_600_000);
  if (!log) {
    console.warn('[cron:random-dream] sub-agent did not complete within timeout');
    return;
  }

  // 解析梦境输出
  const { outputs, contractIds } = extractDreamOutputs(log);
  if (outputs.length === 0) {
    console.warn('[cron:random-dream] no [DREAM_OUTPUT] blocks found in log');
    return;
  }

  console.log(`[cron:random-dream] extracted ${outputs.length} dream output(s)`);

  // 更新 state
  const updatedState: RandomDreamState = {
    processedContractIds: [
      ...new Set([...state.processedContractIds, ...contractIds]),
    ],
  };
  saveRandomDreamState(opts.clawforumDir, updatedState);

  // 投递到 motion inbox
  writeInboxMessage({
    inboxDir: path.join(opts.motionDir, 'inbox', 'pending'),
    type: 'random_dream',
    source: 'cron:dream',
    priority: 'low',
    body: outputs.join('\n\n---\n\n'),
    idPrefix: `${Date.now()}_random_dream`,
    filenameTag: 'random_dream',
    extraFields: { dream_count: String(outputs.length) },
  });
}
