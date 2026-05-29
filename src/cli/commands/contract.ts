/**
 * Contract CLI commands
 */

import * as path from 'path';

import * as yaml from 'js-yaml';
import { ContractSystem, type ContractYaml, type ProgressData } from '../../core/contract/index.js';
import { collectContractEvents } from '../../core/contract/index.js';
import { createDirContext } from '../../foundation/audit/index.js';
import { getClawDir } from '../../foundation/config/index.js';
import { notifySystem } from '../../foundation/messaging/index.js';
// STREAM_AUDIT_EVENTS.APPEND_FAILED → inline string to decouple CLI from stream audit constants (phase1101)
import { createSystemAudit, type AuditLog } from '../../foundation/audit/index.js';
import { CLI_AUDIT_EVENTS } from '../audit-events.js';
import { isFileNotFound } from '../../foundation/fs/types.js';
import { createToolRegistry } from '../../foundation/tools/index.js';
import { STREAM_FILE, createPerResourceStreamWriter, type StreamEvent } from '../../foundation/stream/index.js';
import { CONTRACT_DIR } from '../../core/contract/index.js';
import { CliError } from '../errors.js';
import type { FileSystem } from '../../foundation/fs/types.js';
import type { ClawId } from '../../foundation/identity/index.js';
import { type ContractId, makeContractId } from '../../foundation/identity/index.js';
import { type ClawDir, resolveClawforumRoot } from '../../foundation/identity/index.js';



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

export function notifyContractCreated(deps: { fsFactory: (baseDir: string) => FileSystem }, clawDir: ClawDir, clawId: ClawId, contractId: ContractId, contract: ContractYaml): void {
  const { fs, audit: contractAudit } = createDirContext(deps, clawDir);

  // best-effort：通知 viewport via stream.jsonl（失败不中断 contract 创建）
  // CLI cross-process append to daemon singleton stream — boundary event、low-frequency；
  // 经 L2 createPerResourceStreamWriter（phase 1120 / 应然承认 l2_stream.md §3 边界 co-writer）
  const streamWriter = createPerResourceStreamWriter(fs, STREAM_FILE, contractAudit);
  streamWriter.write({
    ts: Date.now(),
    type: 'user_notify',
    subtype: 'contract_created',
    contractId,
    clawId,
    title: contract.title,
    subtaskCount: contract.subtasks.length,
  } as StreamEvent);

  // 写 inbox 通知，触发 claw daemon 开始执行（best-effort）
  // phase 1419: prefix / 连接词英化（mirror phase 1404 viewport 英化）/ 业务字段保留 user 原文
  const subtaskLines = contract.subtasks.map(s => `- ${s.id}: ${s.description}`).join('\n');
  const lines = [`New contract created (${contractId}): ${contract.title}`];
  if (contract.background) lines.push(`Background: ${contract.background}`);
  lines.push(`Goal: ${contract.goal}`);
  if (contract.expectations) lines.push(`Expectations: ${contract.expectations}`);
  lines.push(`Subtasks:`);
  lines.push(subtaskLines);
  lines.push(`After each subtask, submit verification via done:`);
  lines.push(`done: { "subtask": "<subtask-id>", "evidence": "<output path or completion summary>" }`);
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
export async function contractCreateCommand(deps: { fsFactory: (baseDir: string) => FileSystem }, clawId: ClawId, filePath: string, extraDeps?: { audit?: AuditLog }): Promise<void> {
  const audit = extraDeps?.audit;
  const absFilePath = path.resolve(filePath);
  const fileSystem = deps.fsFactory(path.dirname(absFilePath));
  const yamlContent = fileSystem.readSync(path.basename(absFilePath));
  const contract = parseAndValidateContractYaml(yamlContent);

  const clawDir = getClawDir(clawId);
  const clawFs = deps.fsFactory(clawDir);
  // phase 1389: regular claw clawforumRoot 双层 up / mirror assemble.ts:279 模板 (phase 1387 Step B + bff2dcfc follow-up)
  const clawforumRoot = resolveClawforumRoot(clawDir, /* isMotion */ false);  // phase 1406: 单一 truth source
  const manager = new ContractSystem({ clawDir, clawId, fs: clawFs, audit: createSystemAudit(clawFs, clawDir), toolRegistry: createToolRegistry(), fsFactory: deps.fsFactory, clawforumRoot });

  const contractId = await manager.create(contract);
  audit?.write(CLI_AUDIT_EVENTS.CONTRACT_CREATE, `claw=${clawId}`, `contract=${contractId}`, `mode=file`);
  console.log(`Contract created: ${contractId} for claw ${clawId}`);

  notifyContractCreated(deps, clawDir, clawId, makeContractId(contractId), contract);
}

/**
 * Create a contract from a directory containing contract.yaml + verification/
 */
export async function contractCreateFromDirCommand(deps: { fsFactory: (baseDir: string) => FileSystem }, clawId: ClawId, dirPath: string, extraDeps?: { audit?: AuditLog }): Promise<void> {
  const audit = extraDeps?.audit;
  const absDir = path.resolve(dirPath);
  const srcFs = deps.fsFactory(absDir);

  const yamlContent = srcFs.readSync('contract.yaml');
  const contract = parseAndValidateContractYaml(yamlContent);

  const clawDir = getClawDir(clawId);
  const clawFs = deps.fsFactory(clawDir);
  const clawforumRoot = resolveClawforumRoot(clawDir, /* isMotion */ false);  // phase 1406: 单一 truth source
  const manager = new ContractSystem({ clawDir, clawId, fs: clawFs, audit: createSystemAudit(clawFs, clawDir), toolRegistry: createToolRegistry(), fsFactory: deps.fsFactory, clawforumRoot });

  const contractId = await manager.create(contract);
  audit?.write(CLI_AUDIT_EVENTS.CONTRACT_CREATE, `claw=${clawId}`, `contract=${contractId}`, `mode=dir`);
  console.log(`Contract created: ${contractId} for claw ${clawId}`);

  // Copy verification/ 目录（若存在；回退读取旧版 acceptance/）
  const srcDir = srcFs.existsSync('verification') ? 'verification' : srcFs.existsSync('acceptance') ? 'acceptance' : undefined;
  if (srcDir) {
    const destRel = path.join(CONTRACT_DIR, 'active', contractId, 'verification');
    await clawFs.ensureDir(destRel);
    const entries = await srcFs.list(srcDir);
    for (const entry of entries) {
      const srcRel = path.join(srcDir, entry.name);
      const srcStat = await srcFs.stat(srcRel);
      if (!srcStat.isFile) continue;   // 跳过子目录和符号链接
      const destFileRel = path.join(destRel, entry.name);
      const content = await srcFs.read(srcRel);
      await clawFs.writeAtomic(destFileRel, content);
      // .sh files get 0o755 via writeAtomic default 0o644; skipping chmod as per plan
    }
  }

  notifyContractCreated(deps, clawDir, clawId, makeContractId(contractId), contract);
}

/**
 * Show contract execution log for a claw
 */
export async function contractEventsCommand(deps: { fsFactory: (baseDir: string) => FileSystem }, clawId: ClawId, sinceTs: number): Promise<void> {
  const clawDir = getClawDir(clawId);
  const fs = deps.fsFactory(clawDir);
  const audit = createSystemAudit(fs, clawDir);
  const events = collectContractEvents(fs, clawDir, clawId, sinceTs, audit);
  if (events.length > 0) {
    console.log(events.join('\n'));
  }
}

export async function contractLogCommand(deps: { fsFactory: (baseDir: string) => FileSystem }, clawId: ClawId, contractId?: string): Promise<void> {
  const clawDir = getClawDir(clawId);
  const clawFs = deps.fsFactory(clawDir);
  const clawforumRoot = resolveClawforumRoot(clawDir, /* isMotion */ false);  // phase 1406: 单一 truth source
  const manager = new ContractSystem({ clawDir, clawId, fs: clawFs, audit: createSystemAudit(clawFs, clawDir), toolRegistry: createToolRegistry(), fsFactory: deps.fsFactory, clawforumRoot });

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
    const raw = await manager.readContractYamlRaw(makeContractId(resolvedId));
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
    progress = await manager.getProgress(makeContractId(resolvedId));
  } catch (err) {
    // phase 906 r115 O fork (audit-2026-05-16 NEW.P2.6): narrow to ENOENT only
    // file missing = expected (注释原意「progress 文件缺失」)，其他错误 = real bug bubble
    if (!isFileNotFound(err)) {
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
