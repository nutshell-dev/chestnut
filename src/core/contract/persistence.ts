/**
 * @module L4.ContractSystem.Persistence
 * YAML / progress.json fs helpers
 */

import * as yaml from 'js-yaml';
import type { FileSystem } from '../../foundation/fs/types.js';
import { AUDIT_PREVIEW_LEN } from '../../foundation/audit/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { Contract, ContractStatus } from '../contract/types.js';
import type { ContractYaml, ProgressData } from './types.js';
import { CONTRACT_AUDIT_EVENTS } from './audit-events.js';

const CONTRACT_DEFAULTS = {
  schema_version: 1,
  auth_level: 'auto' as const,
};

const CONTRACT_CURRENT_SCHEMA_VERSION = 1;

export interface PersistenceContext {
  fs: FileSystem;
  audit: AuditLog;
  contractDir: (contractId: string) => Promise<string>;
  getProgress: (contractId: string) => Promise<ProgressData>;
}

export async function loadContractYaml(
  ctx: PersistenceContext,
  contractId: string,
): Promise<ContractYaml> {
  const dir = await ctx.contractDir(contractId);
  const contractPath = `${dir}/${contractId}/contract.yaml`;
  const content = await ctx.fs.read(contractPath);
  const parsed = yaml.load(content) as { title?: unknown; goal?: unknown; subtasks?: unknown; schema_version?: unknown };

  // NEW schema_version invariant（phase 1019 r124 E fork）
  if (parsed?.schema_version !== undefined &&
      (typeof parsed.schema_version !== 'number' || parsed.schema_version > CONTRACT_CURRENT_SCHEMA_VERSION)) {
    ctx.audit.write(
      CONTRACT_AUDIT_EVENTS.CONTRACT_YAML_SCHEMA_INVALID,
      `contractId=${contractId}`,
      `path=${contractPath}`,
      `reason=unknown_schema_version`,
      `actual=${String(parsed.schema_version)}`,
      `current=${CONTRACT_CURRENT_SCHEMA_VERSION}`,
    );
    throw new Error(`contract.yaml unknown schema_version ${String(parsed.schema_version)} for contract ${contractId} (current=${CONTRACT_CURRENT_SCHEMA_VERSION})`);
  }

  if (
    typeof parsed?.title !== 'string' ||
    typeof parsed?.goal !== 'string' ||
    !Array.isArray(parsed?.subtasks)
  ) {
    ctx.audit.write(
      CONTRACT_AUDIT_EVENTS.CONTRACT_YAML_SCHEMA_INVALID,
      `contractId=${contractId}`,
      `path=${contractPath}`,
      `raw=${content.slice(0, AUDIT_PREVIEW_LEN)}`,
    );
    throw new Error(`contract.yaml schema invalid for contract ${contractId}`);
  }
  return parsed as ContractYaml;
}

export async function readContractYamlRaw(
  ctx: PersistenceContext,
  contractId: string,
): Promise<string> {
  const dir = await ctx.contractDir(contractId);
  const contractPath = `${dir}/${contractId}/contract.yaml`;
  return ctx.fs.read(contractPath);
}

export async function loadContract(
  ctx: PersistenceContext,
  contractId: string,
): Promise<Contract> {
  const yamlContract = await loadContractYaml(ctx, contractId);
  const progress = await ctx.getProgress(contractId);
  return {
    id: yamlContract.id ?? contractId,
    title: yamlContract.title,
    description: yamlContract.goal,
    status: progress.status,
    priority: 'normal',
    creator: 'system',
    goal: yamlContract.goal,
    subtasks: yamlContract.subtasks.map(st => {
      const subtask = progress.subtasks[st.id];
      return {
        id: st.id,
        description: st.description,
        status: subtask?.status || 'todo',
        created_at: progress.started_at || new Date().toISOString(),
        updated_at: subtask?.completed_at || new Date().toISOString(),
      };
    }),
    auth_level: yamlContract.auth_level ?? CONTRACT_DEFAULTS.auth_level,
    created_at: progress.started_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

export async function saveProgress(
  ctx: PersistenceContext,
  contractId: string,
  progress: ProgressData,
): Promise<void> {
  const dir = await ctx.contractDir(contractId);
  const progressPath = `${dir}/${contractId}/progress.json`;
  await ctx.fs.writeAtomic(progressPath, JSON.stringify(progress, null, 2));
}

// phase 791 (P0.17): updateContractStatus deleted.
// Function promised persistence but only wrote audit; naming illusion violated M#11.
// COMPLETED audit single-source via archiveAndEmit (acceptance.ts:75).

export async function checkAllSubtasksCompleted(
  ctx: PersistenceContext,
  contractId: string,
  progress: ProgressData,
): Promise<boolean> {
  const contractYaml = await loadContractYaml(ctx, contractId);
  return contractYaml.subtasks.every(st => {
    const subtask = progress.subtasks[st.id];
    return subtask?.status === 'completed';
  });
}
