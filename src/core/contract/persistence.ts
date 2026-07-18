/**
 * @module L4.ContractSystem.Persistence
 * YAML / progress.json fs helpers
 */

import * as yaml from 'js-yaml';
import type { FileSystem } from '../../foundation/fs/index.js';

import type { AuditLog } from '../../foundation/audit/index.js';
import { isFileNotFound } from '../../foundation/fs/index.js';
import { formatErr } from '../../foundation/node-utils/index.js';
import { ToolError } from '../../foundation/tools/errors.js';
import type { Contract } from '../contract/types.js';
import type { ContractYaml } from './types.js';
import type { ProgressData, ContractCorruptionEvidence } from './types.js';
import { stripDerivableStatus, ContractProgressInvariantViolatedError } from './types.js';
import { ContractYamlSchema, ContractProgressPersistedSchema } from './schemas.js';
import { CONTRACT_YAML_FILE } from './dirs.js';
import { makeClawId } from '../../foundation/claw-identity/index.js';
import { emitContractYamlSchemaInvalid } from './audit-emit.js';
import { CONTRACT_AUDIT_EVENTS } from './audit-events.js';
import { isolateCorruptedFile } from './_isolation-helper.js';
// phase 282 Step B: cross-source audit 整文件已删除（status + contract_id + yaml-dep 均 derive）

const CONTRACT_DEFAULTS = {
  schema_version: 1,
  auth_level: 'auto' as const,
};

/**
 * Progress (contract progress.json) 当前 schema 版本号.
 * Derivation: 1 = 首版 schema、未有迁移 / 配 EVOLUTION_STATE_CURRENT_VERSION 同型经验值（业务初版 schema 均 1）/
 * 升级时 read 路径用版本号区分 migration.
 */
export const PROGRESS_CURRENT_SCHEMA_VERSION = 1;

export interface PersistenceContext {
  fs: FileSystem;
  audit: AuditLog;
  contractDir: (contractId: ContractId) => Promise<string>;
  getProgress: (contractId: ContractId) => Promise<ProgressData | null>;
  markCorrupted?: (contractId: ContractId, evidence: ContractCorruptionEvidence) => Promise<void>;
}

export async function loadContractYaml(
  ctx: PersistenceContext,
  contractId: ContractId,
): Promise<ContractYaml | null> {
  const dir = await ctx.contractDir(contractId);
  const contractPath = `${dir}/${contractId}/contract.yaml`;
  const content = await ctx.fs.read(contractPath);

  // phase 959: YAML parse errors must follow the same isolation path as schema errors.
  let rawParsed: unknown;
  try {
    rawParsed = yaml.load(content);
  } catch (yamlErr) {
    emitContractYamlSchemaInvalid(
      ctx.audit,
      {
        contractId,
        path: contractPath,
        reason: 'yaml_parse_failed',
        error: formatErr(yamlErr),
      },
    );
    const contractDir = await ctx.contractDir(contractId);
    const isolated = await isolateCorruptedFile(ctx.fs, ctx.audit, {
      contractId, contractDir: `${contractDir}/${contractId}`, filename: CONTRACT_YAML_FILE,
      reason: 'yaml_parse_error',
    });
    if (isolated && ctx.markCorrupted) {
      await ctx.markCorrupted(contractId, {
        reason: 'yaml_parse_error',
        relativePath: isolated.relativePath,
      });
    }
    return null;
  }

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
    const isolated = await isolateCorruptedFile(ctx.fs, ctx.audit, {
      contractId, contractDir: `${contractDir}/${contractId}`, filename: CONTRACT_YAML_FILE,
      reason: 'schema_invalid',
    });
    if (isolated && ctx.markCorrupted) {
      await ctx.markCorrupted(contractId, {
        reason: 'yaml_schema_invalid',
        relativePath: isolated.relativePath,
      });
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
  knownDir?: string,
): Promise<void> {
  const dir = knownDir ?? await ctx.contractDir(contractId);
  const progressPath = `${dir}/${contractId}/progress.json`;
  // phase 319: ProgressData.schema_version now z.literal(1) brand (Zod SoT)、显式 set 保 writer SoT
  const progressToSave = { ...progress, schema_version: PROGRESS_CURRENT_SCHEMA_VERSION };
  // phase 282 Step B: 落盘时不写 contract_id（derive from caller-provided dir）
  delete (progressToSave as Record<string, unknown>).contract_id;
  // phase 282 Step A: 对于可从 subtasks derive 的状态（completed/running/pending），
  // 落盘时不写 status（消除双源）。对于不可 derive 的生命周期状态
  //（cancelled/crashed/archive_pending_recovery），暂时保留以
  // 避免状态丢失（未来可迁移到独立持久化标记如 cancelled_at/crashed_at）。
  // phase 1125 Step B: 'paused' 已从当前 lifecycle 移除；legacy paused 由独立 reader
  //（findLegacyPausedContracts / listLegacyPausedContracts）承担，不再经 progress.json 状态机流转。
  // phase 342: stripDerivableStatus helper (ML#1 共用基础设施单源)
  stripDerivableStatus(progressToSave as Record<string, unknown>);

  // phase 319: Zod SoT safeParse defensive (replace assertProgressShapeInvariants、ML#9 优先编译器检查)
  // phase 406 Step C (review N10): refuse to persist known-invalid shape — pre-N10
  //   行为是「audit emit + 不阻 save」、let loader markCrashed cascade against
  //   the corrupt JSON we just wrote. Now throw、caller decides 回退 vs abort.
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
    throw new ContractProgressInvariantViolatedError(
      `progress shape invalid: ${firstIssue?.message ?? 'unknown'}`,
      { contractId, issuePath: firstIssue?.path.join('.') ?? 'unknown' },
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
import { CLAWS_DIR } from '../../core/claw-topology/claw-instance-paths.js';
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
