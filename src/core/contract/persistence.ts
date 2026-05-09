/**
 * @module L4.ContractSystem.Persistence
 * YAML / progress.json fs helpers
 */

import * as yaml from 'js-yaml';
import type { FileSystem } from '../../foundation/fs/types.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { Contract, ContractStatus } from '../../types/contract.js';
import type { ContractYaml, ProgressData } from './types.js';
import { CONTRACT_AUDIT_EVENTS } from './audit-events.js';

const CONTRACT_DEFAULTS = {
  schema_version: 1,
  auth_level: 'auto' as const,
};

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
  const parsed = yaml.load(content) as { title?: unknown; goal?: unknown; subtasks?: unknown };
  if (
    typeof parsed?.title !== 'string' ||
    typeof parsed?.goal !== 'string' ||
    !Array.isArray(parsed?.subtasks)
  ) {
    ctx.audit.write(
      CONTRACT_AUDIT_EVENTS.CONTRACT_YAML_SCHEMA_INVALID,
      `contractId=${contractId}`,
      `path=${contractPath}`,
      `raw=${content.slice(0, 100)}`,
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
    subtasks: yamlContract.subtasks.map(st => ({
      id: st.id,
      description: st.description,
      status: progress.subtasks[st.id]?.status || 'todo',
      created_at: progress.started_at || new Date().toISOString(),
      updated_at: progress.subtasks[st.id]?.completed_at || new Date().toISOString(),
    })),
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

export async function updateContractStatus(
  ctx: PersistenceContext,
  contractId: string,
  status: ContractStatus,
): Promise<void> {
  if (status === 'completed') {
    ctx.audit.write(CONTRACT_AUDIT_EVENTS.COMPLETED, contractId);
  }
}

export async function checkAllSubtasksCompleted(
  ctx: PersistenceContext,
  contractId: string,
  progress: ProgressData,
): Promise<boolean> {
  const contractYaml = await loadContractYaml(ctx, contractId);
  return contractYaml.subtasks.every(st =>
    progress.subtasks[st.id]?.status === 'completed'
  );
}
