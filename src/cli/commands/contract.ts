/**
 * Contract CLI commands
 */

import * as fs from 'fs/promises';
import * as fsNative from 'fs';
import * as path from 'path';

import * as yaml from 'js-yaml';
import { ContractSystem, type ContractYaml, type ProgressData } from '../../core/contract/index.js';
import { collectContractEvents } from '../../core/contract/index.js';
import { createDirContext } from '../utils/factories.js';
import { NodeFileSystem } from '../../foundation/fs/node-fs.js';
import { getClawDir } from '../../foundation/config/index.js';
import { notifySystem } from '../../foundation/messaging/index.js';
// STREAM_AUDIT_EVENTS.APPEND_FAILED → inline string to decouple CLI from stream audit constants (phase1101)
import { createSystemAudit, type AuditLog } from '../../foundation/audit/index.js';
import { CLI_AUDIT_EVENTS } from '../audit-events.js';
import { createToolRegistry } from '../../foundation/tools/index.js';
import { STREAM_FILE } from '../../foundation/stream/index.js';
import { CONTRACT_DIR } from '../../core/contract/index.js';
import { CliError } from '../errors.js';


function parseAndValidateContractYaml(yamlContent: string): ContractYaml {
  const parsed = yaml.load(yamlContent);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new CliError('Contract YAML must be an object');
  }
  const contract = parsed as ContractYaml;
  if (!contract.title) { throw new CliError('Contract YAML missing required field: title'); }
  if (!contract.goal) { throw new CliError('Contract YAML missing required field: goal'); }
  if (!Array.isArray(contract.subtasks)) {
    throw new CliError(`Contract YAML "subtasks" must be an array (use "- id: ..." list syntax), got: ${typeof contract.subtasks}`);
  }
  return contract;
}

export function notifyContractCreated(clawDir: string, clawId: string, contractId: string, contract: ContractYaml): void {
  const { fs, audit: contractAudit } = createDirContext(clawDir);

  // best-effort：通知 viewport via stream.jsonl（失败不中断 contract 创建）
  const streamLine = JSON.stringify({
    ts: Date.now(), type: 'user_notify', subtype: 'contract_created',
    contractId, clawId, title: contract.title, subtaskCount: contract.subtasks.length,
  }) + '\n';
  try {
    fs.appendSync(STREAM_FILE, streamLine);
  } catch (err) {
    contractAudit.write(
      'stream_append_failed',
      `context=contract_notify`,
      `contractId=${contractId}`,
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
    { type: 'message', priority: 'high', idPrefix: 'contract-new' }
  );
}

/**
 * Create a contract for a claw
 */
export async function contractCreateCommand(clawId: string, filePath: string, deps?: { audit?: AuditLog }): Promise<void> {
  const audit = deps?.audit;
  const yamlContent = await fs.readFile(filePath, 'utf-8');
  const contract = parseAndValidateContractYaml(yamlContent);

  const clawDir = getClawDir(clawId);
  const clawFs = new NodeFileSystem({ baseDir: clawDir });
  const manager = new ContractSystem(clawDir, clawId, clawFs, createSystemAudit(clawFs, clawDir), undefined, createToolRegistry());

  const contractId = await manager.create(contract);
  audit?.write(CLI_AUDIT_EVENTS.CONTRACT_CREATE, `claw=${clawId}`, `contract=${contractId}`, `mode=file`);
  console.log(`Contract created: ${contractId} for claw ${clawId}`);

  notifyContractCreated(clawDir, clawId, contractId, contract);
}

/**
 * Create a contract from a directory containing contract.yaml + acceptance/
 */
export async function contractCreateFromDirCommand(clawId: string, dirPath: string, deps?: { audit?: AuditLog }): Promise<void> {
  const audit = deps?.audit;
  const absDir = path.resolve(dirPath);

  const yamlContent = await fs.readFile(path.join(absDir, 'contract.yaml'), 'utf-8');
  const contract = parseAndValidateContractYaml(yamlContent);

  const clawDir = getClawDir(clawId);
  const clawFs = new NodeFileSystem({ baseDir: clawDir });
  const manager = new ContractSystem(clawDir, clawId, clawFs, createSystemAudit(clawFs, clawDir), undefined, createToolRegistry());

  const contractId = await manager.create(contract);
  audit?.write(CLI_AUDIT_EVENTS.CONTRACT_CREATE, `claw=${clawId}`, `contract=${contractId}`, `mode=dir`);
  console.log(`Contract created: ${contractId} for claw ${clawId}`);

  // Copy acceptance/ 目录（若存在）
  const srcAcceptance = path.join(absDir, 'acceptance');
  if (fsNative.existsSync(srcAcceptance)) {
    const destAcceptance = path.join(clawDir, CONTRACT_DIR, 'active', contractId, 'acceptance');
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
  const fs = new NodeFileSystem({ baseDir: clawDir });
  const audit = createSystemAudit(fs, clawDir);
  const events = collectContractEvents(fs, clawDir, clawId, sinceTs, audit);
  if (events.length > 0) {
    console.log(events.join('\n'));
  }
}

export async function contractLogCommand(clawId: string, contractId?: string): Promise<void> {
  const clawDir = getClawDir(clawId);
  const clawFs = new NodeFileSystem({ baseDir: clawDir });
  const manager = new ContractSystem(clawDir, clawId, clawFs, createSystemAudit(clawFs, clawDir), undefined, createToolRegistry());

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
  } catch (err) {
    // phase 906 r115 O fork (audit-2026-05-16 NEW.P2.6): preserve Error cause chain
    throw new CliError(
      `Contract "${resolvedId}" not found for claw ${clawId}`,
      { cause: err },
    );
  }

  // 读 progress（active/paused/archive 均可）
  let progress: ProgressData | null = null;
  try {
    progress = await manager.getProgress(resolvedId);
  } catch (err) {
    // phase 906 r115 O fork (audit-2026-05-16 NEW.P2.6): narrow to ENOENT only
    // file missing = expected (注释原意「progress 文件缺失」)，其他错误 = real bug bubble
    if ((err as { code?: string })?.code !== 'ENOENT') {
      throw err;
    }
  }

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
      const feedbackDisplay = st.last_failed_feedback.feedback;
      console.log(`               Last feedback: ${feedbackDisplay}`);
    }
    if (st?.retry_count) {
      console.log(`               Retries: ${st.retry_count}`);
    }
  }
}
