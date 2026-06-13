/**
 * @module L4.ContractSystem.Persistence
 * YAML / progress.json fs helpers
 */

import * as yaml from 'js-yaml';
import type { FileSystem } from '../../foundation/fs/types.js';

import type { AuditLog } from '../../foundation/audit/index.js';
import { isFileNotFound } from '../../foundation/fs/types.js';
import { formatErr } from '../../foundation/utils/index.js';
import { ToolError } from '../../foundation/errors.js';
import type { Contract } from '../contract/types.js';
import type { ContractYaml } from './types.js';
import type { ProgressData } from './types.js';
import { ContractYamlSchema, ContractProgressPersistedSchema } from './schemas.js';
import { makeClawId } from '../../constants.js';
import { emitContractYamlSchemaInvalid } from './audit-emit.js';
import { CONTRACT_AUDIT_EVENTS } from './audit-events.js';
import { isolateCorruptedFile } from './_isolation-helper.js';
// phase 282 Step B: cross-source audit 整文件已删除（status + contract_id + yaml-dep 均 derive）

const CONTRACT_DEFAULTS = {
  schema_version: 1,
  auth_level: 'auto' as const,
};

export const PROGRESS_CURRENT_SCHEMA_VERSION = 1;

export interface PersistenceContext {
  fs: FileSystem;
  audit: AuditLog;
  contractDir: (contractId: ContractId) => Promise<string>;
  getProgress: (contractId: ContractId) => Promise<ProgressData | null>;
  markCrashed?: (contractId: ContractId, cause: string) => Promise<void>;
}

export async function loadContractYaml(
  ctx: PersistenceContext,
  contractId: ContractId,
): Promise<ContractYaml | null> {
  const dir = await ctx.contractDir(contractId);
  const contractPath = `${dir}/${contractId}/contract.yaml`;
  const content = await ctx.fs.read(contractPath);
  const rawParsed = yaml.load(content);
  const result = ContractYamlSchema.safeParse(rawParsed);
  if (!result.success) {
    emitContractYamlSchemaInvalid(
      ctx.audit,
      {
        contractId,
        path: contractPath,
        reason: 'schema_invalid',
        actual: result.error.issues[0]?.path.join('.') ?? 'unknown',
        raw: ctx.audit.preview(content),
      },
    );
    const contractDir = await ctx.contractDir(contractId);
    await isolateCorruptedFile(ctx.fs, ctx.audit, {
      contractId, contractDir: `${contractDir}/${contractId}`, filename: 'contract.yaml',
      reason: 'schema_invalid',
    });
    if (ctx.markCrashed) {
      await ctx.markCrashed(contractId, 'system: schema_corruption_contract_yaml');
    }
    return null;
  }
  return result.data;
}

export async function readContractYamlRaw(
  ctx: PersistenceContext,
  contractId: ContractId,
): Promise<string> {
  const dir = await ctx.contractDir(contractId);
  const contractPath = `${dir}/${contractId}/contract.yaml`;
  return ctx.fs.read(contractPath);
}

export async function loadContract(
  ctx: PersistenceContext,
  contractId: ContractId,
): Promise<Contract> {
  const yamlContract = await loadContractYaml(ctx, contractId);
  if (!yamlContract) {
    throw new ToolError(`Contract "${contractId}" unloadable: contract.yaml schema corruption`);
  }
  const progress = await ctx.getProgress(contractId);
  if (!progress) {
    throw new ToolError(`Contract "${contractId}" unloadable: progress schema corruption`);
  }
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
  contractId: ContractId,
  progress: ProgressData,
): Promise<void> {
  const dir = await ctx.contractDir(contractId);
  const progressPath = `${dir}/${contractId}/progress.json`;
  // phase 319: ProgressData.schema_version now z.literal(1) brand (Zod SoT)、显式 set 保 writer SoT
  const progressToSave = { ...progress, schema_version: PROGRESS_CURRENT_SCHEMA_VERSION };
  // phase 282 Step B: 落盘时不写 contract_id（derive from caller-provided dir）
  delete (progressToSave as Record<string, unknown>).contract_id;
  // phase 282 Step A: 对于可从 subtasks derive 的状态（completed/running/pending），
  // 落盘时不写 status（消除双源）。对于不可 derive 的生命周期状态
  //（cancelled/crashed/paused/archive_pending_recovery），暂时保留以
  // 避免状态丢失（未来可迁移到独立持久化标记如 cancelled_at/crashed_at）。
  const DERIVABLE_STATUSES = new Set<string>(['completed', 'running', 'pending']);
  if (DERIVABLE_STATUSES.has(progressToSave.status)) {
    delete (progressToSave as Record<string, unknown>).status;
  }

  // phase 319: Zod SoT safeParse defensive (replace assertProgressShapeInvariants、ML#9 优先编译器检查)
  // phase 233 Step A anchor: 违例 emit audit、不 throw、不阻 save、Path #4 防 break
  const validation = ContractProgressPersistedSchema.safeParse(progressToSave);
  if (!validation.success) {
    const firstIssue = validation.error.issues[0];
    ctx.audit.write(
      CONTRACT_AUDIT_EVENTS.CONTRACT_PROGRESS_INVARIANT_VIOLATED,
      `kind=${firstIssue?.code ?? 'unknown'}`,
      `contract_id=${contractId}`,
      `path=${firstIssue?.path.join('.') ?? 'unknown'}`,
      `message=${firstIssue?.message ?? 'unknown'}`,
      `source=saveProgress`,
    );
  }

  // phase 282 Step B: cross-source audit 整文件已删除

  await ctx.fs.writeAtomic(progressPath, JSON.stringify(progressToSave, null, 2));
}

// phase 791 (P0.17): updateContractStatus deleted.
// Function promised persistence but only wrote audit; naming illusion violated M#11.
// COMPLETED audit single-source via archiveAndEmit (verification.ts:75).

export async function checkAllSubtasksCompleted(
  ctx: PersistenceContext,
  contractId: ContractId,
  progress: ProgressData,
): Promise<boolean> {
  const contractYaml = await loadContractYaml(ctx, contractId);
  if (!contractYaml) {
    throw new ToolError(`Contract "${contractId}" unloadable: contract.yaml schema corruption`);
  }
  return contractYaml.subtasks.every(st => {
    const subtask = progress.subtasks[st.id];
    return subtask?.status === 'completed';
  });
}

import { CONTRACT_ARCHIVE_DIR } from './dirs.js';
import { CLAWS_DIR } from '../../foundation/claw-paths.js';
import type { ArchiveContractRef } from './types.js';
import { type ContractId, makeContractId } from './types.js';


/**
 * Phase 1335 (r138 F fork): cross-module query API — list archived contracts
 * M#3 资源唯一归属：ContractSystem own archive / caller 不直访 fs
 */
export async function listArchiveContracts(opts: {
  fs: FileSystem;
  filter?: { sinceMs?: number; untilMs?: number };
  audit?: AuditLog;  // NEW phase 164
}): Promise<ArchiveContractRef[]> {
  const { fs, filter } = opts;
  const results: ArchiveContractRef[] = [];

  if (!fs.existsSync(CLAWS_DIR)) return results;

  for (const e of fs.listSync(CLAWS_DIR, { includeDirs: true })) {
    const clawId = e.name;
    const archiveDir = `${CLAWS_DIR}/${clawId}/${CONTRACT_ARCHIVE_DIR}`;
    if (!fs.existsSync(archiveDir)) continue;

    for (const ce of fs.listSync(archiveDir, { includeDirs: true })) {
      const contractId = ce.name;
      const contractDir = `${archiveDir}/${contractId}`;
      if (!fs.statSync(contractDir).isDirectory) continue;

      let archivedAt: string | undefined;
      try {
        const progressRaw = fs.readSync(`${contractDir}/progress.json`);
        const progress = JSON.parse(progressRaw) as {
          completed_at?: string;
          subtasks?: Record<string, { completed_at?: string }>;
        };
        archivedAt = progress.completed_at;
        // phase 280 fallback: derive archive time from subtask completed_at when top-level field absent
        if (archivedAt === undefined && progress.subtasks) {
          const subtaskTimes = Object.values(progress.subtasks)
            .map((st) => st.completed_at)
            .filter((t): t is string => typeof t === 'string');
          if (subtaskTimes.length > 0) {
            archivedAt = subtaskTimes.sort((a, b) => (a < b ? 1 : -1))[0];
          }
        }
      } catch (err) {
        if (!isFileNotFound(err)) {
          opts.audit?.write(
            CONTRACT_AUDIT_EVENTS.ARCHIVE_PROGRESS_READ_FAILED,
            `clawId=${clawId}`,
            `contractId=${contractId}`,
            `error=${formatErr(err)}`,
          );
        }
        // ENOENT 合法 / 其他错 audit + archivedAt 仍 undefined + 继续列举
      }

      if (filter?.sinceMs !== undefined || filter?.untilMs !== undefined) {
        const at = archivedAt ? new Date(archivedAt).getTime() : 0;
        if (filter.sinceMs !== undefined && at < filter.sinceMs) continue;
        if (filter.untilMs !== undefined && at > filter.untilMs) continue;
      }

      results.push({ clawId: makeClawId(clawId), contractId: makeContractId(contractId), contractDir, archivedAt });
    }
  }

  return results;
}
