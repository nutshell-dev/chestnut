/**
 * @module L6.CLI.Commands.Contract.Helpers
 * phase 31 P1.1: contract.ts 拆 file 后共享 helper。
 */

import * as yaml from 'js-yaml';
import type { ContractYaml } from '../../core/contract/index.js';
import { createDirContext } from '../../foundation/audit/index.js';
import { notifyClaw } from '../../foundation/messaging/index.js';
import { MOTION_CLAW_ID } from '../../core/claw-topology/index.js';
import { STREAM_FILE, createPerResourceStreamWriter, type StreamEvent } from '../../foundation/stream/index.js';
import { CliError } from '../errors.js';
import type { FileSystem } from '../../foundation/fs/types.js';
import type { ContractId } from '../../core/contract/types.js';
import { ContractValidationError } from '../../core/contract/index.js';

export function parseAndValidateContractYaml(yamlContent: string): ContractYaml {
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

export function formatContractValidationError(err: ContractValidationError): void {
  console.error(`[contract create] yaml validation failed:`);
  console.error(`  field:    ${err.field}`);
  console.error(`  kind:     ${err.kind}`);
  console.error(`  message:  ${err.message}`);
  if (err.context) {
    console.error(`  context:`);
    for (const [k, v] of Object.entries(err.context)) {
      console.error(`    ${k}: ${v}`);
    }
  }
  console.error('');
  console.error('Fix: update the contract yaml according to the message above, then re-run chestnut contract create');
}

export function notifyContractCreated(deps: { fsFactory: (baseDir: string) => FileSystem }, clawDir: string, clawId: string, contractId: ContractId, contract: ContractYaml, chestnutRoot: string): void {
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
  notifyClaw(
    fs,
    chestnutRoot,
    MOTION_CLAW_ID,
    clawId,
    { type: 'contract_created', source: 'system', priority: 'high', body, idPrefix: 'contract-new' },
    contractAudit,
  );
}
