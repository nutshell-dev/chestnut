/**
 * Contract CLI commands
 */

import * as fs from 'fs/promises';
import * as fsNative from 'fs';
import * as path from 'path';

import * as yaml from 'js-yaml';
import { ContractManager, type ContractYaml, type ProgressData } from '../../core/contract/manager.js';
import { NodeFileSystem } from '../../foundation/fs/node-fs.js';
import { getClawDir } from '../config.js';
import { notifySystem } from '../../utils/notify.js';
import { AuditWriter } from '../../foundation/audit/index.js';
import { AUDIT_EVENTS } from '../../foundation/audit/events.js';
import { STREAM_FILE } from '../../foundation/stream/index.js';


function parseAndValidateContractYaml(yamlContent: string): ContractYaml {
  const parsed = yaml.load(yamlContent);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Contract YAML must be an object');
  }
  const contract = parsed as ContractYaml;
  if (!contract.title) { throw new Error('Contract YAML missing required field: title'); }
  if (!contract.goal) { throw new Error('Contract YAML missing required field: goal'); }
  if (!Array.isArray(contract.subtasks)) {
    throw new Error(`Contract YAML "subtasks" must be an array (use "- id: ..." list syntax), got: ${typeof contract.subtasks}`);
  }
  return contract;
}

function notifyContractCreated(clawDir: string, clawId: string, contractId: string, contract: ContractYaml): void {
  const fs = new NodeFileSystem({ baseDir: clawDir, enforcePermissions: false });
  const contractAudit = new AuditWriter(fs, path.join(clawDir, 'audit.tsv'));

  // best-effort：通知 viewport via stream.jsonl（失败不中断 contract 创建）
  const streamLine = JSON.stringify({
    ts: Date.now(), type: 'user_notify', subtype: 'contract_created',
    contractId, clawId, title: contract.title, subtaskCount: contract.subtasks.length,
  }) + '\n';
  try {
    fs.appendSync(STREAM_FILE, streamLine);
  } catch (err) {
    contractAudit.write(
      AUDIT_EVENTS.STREAM_APPEND_FAILED,
      `context=contract_notify`,
      `reason=${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 写 inbox 通知，触发 claw daemon 开始执行（best-effort）
  const subtaskLines = contract.subtasks.map(s => `- ${s.id}: ${s.description}`).join('\n');
  const lines = [`新契约已创建（${contractId}）：${contract.title}`];
  if (contract.background) lines.push(`背景：${contract.background}`);
  lines.push(`目标：${contract.goal}`);
  if (contract.expectations) lines.push(`执行要求：${contract.expectations}`);
  lines.push(`子任务：`);
  lines.push(subtaskLines);
  lines.push(`执行完每个子任务后，调用 done 提交验收：`);
  lines.push(`done: { "subtask": "<subtask-id>", "evidence": "<产出物路径或完成摘要>" }`);
  const body = lines.join('\n');
  notifySystem(
    fs,
    path.join(clawDir, 'inbox', 'pending'),
    body,
    contractAudit,
    { type: 'message', priority: 'high', idPrefix: 'contract-new' },
    'contract'
  );
}

/**
 * Create a contract for a claw
 */
export async function contractCreateCommand(clawId: string, filePath: string): Promise<void> {
  const yamlContent = await fs.readFile(filePath, 'utf-8');
  const contract = parseAndValidateContractYaml(yamlContent);

  const clawDir = getClawDir(clawId);
  const clawFs = new NodeFileSystem({ baseDir: clawDir, enforcePermissions: false });
  const manager = new ContractManager(clawDir, clawId, clawFs);

  const contractId = await manager.create(contract);
  console.log(`Contract created: ${contractId} for claw ${clawId}`);

  notifyContractCreated(clawDir, clawId, contractId, contract);
}

/**
 * Create a contract from a directory containing contract.yaml + acceptance/
 */
export async function contractCreateFromDirCommand(clawId: string, dirPath: string): Promise<void> {
  const absDir = path.resolve(dirPath);

  const yamlContent = await fs.readFile(path.join(absDir, 'contract.yaml'), 'utf-8');
  const contract = parseAndValidateContractYaml(yamlContent);

  const clawDir = getClawDir(clawId);
  const clawFs = new NodeFileSystem({ baseDir: clawDir, enforcePermissions: false });
  const manager = new ContractManager(clawDir, clawId, clawFs);

  const contractId = await manager.create(contract);
  console.log(`Contract created: ${contractId} for claw ${clawId}`);

  // Copy acceptance/ 目录（若存在）
  const srcAcceptance = path.join(absDir, 'acceptance');
  if (fsNative.existsSync(srcAcceptance)) {
    const destAcceptance = path.join(clawDir, 'contract', 'active', contractId, 'acceptance');
    await fs.mkdir(destAcceptance, { recursive: true });
    const entries = await fs.readdir(srcAcceptance);
    for (const entry of entries) {
      const src = path.join(srcAcceptance, entry);
      const srcStat = await fs.stat(src);
      if (!srcStat.isFile()) continue;   // 跳过子目录和符号链接
      const dest = path.join(destAcceptance, entry);
      await fs.copyFile(src, dest);
      if (entry.endsWith('.sh')) {
        await fs.chmod(dest, 0o755);
      }
    }
  }

  notifyContractCreated(clawDir, clawId, contractId, contract);
}

/**
 * Show contract execution log for a claw
 */
export async function contractEventsCommand(clawId: string, sinceTs: number): Promise<void> {
  const clawDir = getClawDir(clawId);
  const clawFs = new NodeFileSystem({ baseDir: clawDir, enforcePermissions: false });
  const manager = new ContractManager(clawDir, clawId, clawFs);

  const events: string[] = [];

  // 1. 检查 archive 中新完成的契约
  const archiveDir = path.join(clawDir, 'contract', 'archive');
  try {
    const dirs = fsNative.readdirSync(archiveDir, { withFileTypes: true })
      .filter(e => e.isDirectory());
    for (const d of dirs) {
      const progressPath = path.join(archiveDir, d.name, 'progress.json');
      try {
        const raw = fsNative.readFileSync(progressPath, 'utf-8');
        const progress = JSON.parse(raw) as ProgressData;
        // 检查是否有在 sinceTs 之后完成的子任务
        const completedAfter = Object.values(progress.subtasks)
          .some(s => s.completed_at && new Date(s.completed_at).getTime() > sinceTs);
        if (completedAfter && progress.status === 'completed') {
          events.push(`[contract_completed] claw=${clawId} contract=${d.name}`);
        }
      } catch { /* 跳过 */ }
    }
  } catch { /* archive 不存在 */ }

  // 2. 检查 active 中的升级事件（retry_count 达到阈值）
  const activeDir = path.join(clawDir, 'contract', 'active');
  try {
    const dirs = fsNative.readdirSync(activeDir, { withFileTypes: true })
      .filter(e => e.isDirectory());
    for (const d of dirs) {
      const progressPath = path.join(activeDir, d.name, 'progress.json');
      try {
        const raw = fsNative.readFileSync(progressPath, 'utf-8');
        const progress = JSON.parse(raw) as ProgressData;
        // 检查升级事件（edge-triggered：只看 escalated_at 时间戳）
        for (const [stId, st] of Object.entries(progress.subtasks)) {
          if (st.escalated_at && new Date(st.escalated_at).getTime() > sinceTs) {
            events.push(`[contract_escalation] claw=${clawId} contract=${d.name} subtask=${stId} retry_count=${st.retry_count}`);
          }
        }
      } catch { /* 跳过 */ }
    }
  } catch { /* active 不存在 */ }

  // 输出事件（空则无输出）
  if (events.length > 0) {
    console.log(events.join('\n'));
  }
}

export async function contractLogCommand(clawId: string, contractId?: string): Promise<void> {
  const clawDir = getClawDir(clawId);
  const clawFs = new NodeFileSystem({ baseDir: clawDir, enforcePermissions: false });
  const manager = new ContractManager(clawDir, clawId, clawFs);

  // 若未指定 contractId，用 active 契约
  let resolvedId = contractId;
  if (!resolvedId) {
    const active = await manager.loadActive();
    if (!active) {
      console.log(`No active contract for claw ${clawId}`);
      return;
    }
    resolvedId = active.id;
  }

  // 读契约 YAML（active/paused/archive 均可）
  let contractYaml: ContractYaml;
  try {
    const raw = await manager.readContractYamlRaw(resolvedId);
    contractYaml = yaml.load(raw) as ContractYaml;
  } catch {
    throw new Error(`Contract "${resolvedId}" not found for claw ${clawId}`);
  }

  // 读 progress（active/paused/archive 均可）
  let progress: ProgressData | null = null;
  try {
    progress = await manager.getProgress(resolvedId);
  } catch { /* progress 文件缺失时忽略 */ }

  console.log(`Contract: ${resolvedId}`);
  console.log(`Title: ${contractYaml.title}`);
  console.log(`Goal: ${contractYaml.goal}`);
  console.log(`Status: ${progress?.status ?? 'unknown'}`);
  if (progress?.started_at) console.log(`Started: ${progress.started_at}`);
  console.log('');
  console.log('Subtasks:');

  for (const subtask of contractYaml.subtasks) {
    const st = progress?.subtasks[subtask.id];
    const status = st?.status ?? 'pending';
    const label = `[${status}]`.padEnd(13);
    console.log(`  ${label} ${subtask.id}: ${subtask.description}`);
    if (st?.evidence) {
      const ev = st.evidence.length > 300 ? st.evidence.slice(0, 300) + '…' : st.evidence;
      console.log(`               Evidence: ${ev}`);
    }
    if (st?.last_failed_feedback) {
      let feedbackDisplay = st.last_failed_feedback;
      try {
        const parsed = JSON.parse(st.last_failed_feedback);
        if (parsed.reason) feedbackDisplay = parsed.reason;
      } catch { /* not JSON, use as-is */ }
      console.log(`               Last feedback: ${feedbackDisplay}`);
    }
    if (st?.retry_count) {
      console.log(`               Retries: ${st.retry_count}`);
    }
  }
}
