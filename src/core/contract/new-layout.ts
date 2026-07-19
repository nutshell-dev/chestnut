/**
 * @module L4.ContractSystem.NewLayout
 * Phase 1134: new active/current layout primitives (read-only in Step C;
 * staging prepare/commit/cleanup added in Step D).
 *
 * Dependency direction: dirs/types/schemas → new-layout reader/repository.
 * Legacy locations/persistence do NOT call into this module in this phase.
 */

import * as path from 'path';
import * as yaml from 'js-yaml';
import { isFileNotFound, type FileSystem } from '../../foundation/fs/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { formatErr } from '../../foundation/node-utils/index.js';
import { CONTRACT_AUDIT_EVENTS } from './audit-events.js';
import {
  CONTRACT_ACTIVE_CURRENT_DIR,
  CONTRACT_STAGING_DIR,
  CONTRACT_SUBTASKS_DIR,
  CONTRACT_YAML_FILE,
} from './dirs.js';
import {
  PersistedContractYamlSchema,
  SubtaskRuntimeRecordSchema,
} from './schemas.js';
import type { PersistedContractYaml, SubtaskRuntimeRecord } from './types.js';
import {
  ContractLayoutCorruptedError,
  ActiveContractSlotOccupiedError,
  ContractStagingCorruptedError,
} from './errors.js';

export type ContractAggregateStatus = 'pending' | 'running' | 'completed';

export interface CurrentContractLayout {
  root: string;
  contract: PersistedContractYaml;
  subtasks: ReadonlyMap<string, SubtaskRuntimeRecord>;
  aggregate: ContractAggregateStatus;
}

export interface SubtaskRetrySummary {
  retryCount: number;
  lastFailure?: {
    attemptId: string;
    finishedAt: string;
    feedback?: string;
    cause?: string;
  };
}

export interface PreparedStaging {
  creationId: string;
  root: string;
}

// ============================================================================
// Path helpers (relative to the FileSystem baseDir)
// ============================================================================

export function getContractStagingRoot(creationId: string): string {
  return path.join(CONTRACT_STAGING_DIR, creationId);
}

export function getContractActiveCurrentRoot(): string {
  return CONTRACT_ACTIVE_CURRENT_DIR;
}

export function getContractSubtasksDir(root: string): string {
  return path.join(root, CONTRACT_SUBTASKS_DIR);
}

export function getContractYamlPath(root: string): string {
  return path.join(root, CONTRACT_YAML_FILE);
}

// ============================================================================
// Audit helpers
// ============================================================================

function emitLayoutCorrupted(
  audit: AuditLog,
  root: string,
  cause: string,
  detail?: string,
): void {
  audit.write(
    CONTRACT_AUDIT_EVENTS.LAYOUT_CORRUPTED,
    `root=${root}`,
    `cause=${cause}`,
    detail ? `detail=${audit.preview(detail)}` : '',
  );
}

// ============================================================================
// Shared strict layout reader (used by current slot and staging readback)
// ============================================================================

interface ReadLayoutResult {
  contract: PersistedContractYaml;
  subtasks: Map<string, SubtaskRuntimeRecord>;
}

async function readContractLayoutAtRoot(
  deps: { fs: FileSystem; audit: AuditLog },
  root: string,
  expectedContract?: PersistedContractYaml,
): Promise<ReadLayoutResult> {
  const yamlPath = getContractYamlPath(root);
  let content: string;
  try {
    content = await deps.fs.read(yamlPath);
  } catch (err) {
    if (isFileNotFound(err)) {
      emitLayoutCorrupted(deps.audit, root, 'yaml_missing', `path=${yamlPath}`);
      throw new ContractLayoutCorruptedError(
        `contract.yaml missing at ${root}`,
        { root, cause: 'yaml_missing', yamlPath },
      );
    }
    throw err;
  }

  let raw: unknown;
  try {
    raw = yaml.load(content);
  } catch (yamlErr) {
    const detail = formatErr(yamlErr);
    emitLayoutCorrupted(deps.audit, root, 'yaml_parse_error', detail);
    throw new ContractLayoutCorruptedError(
      `contract.yaml parse error at ${root}: ${detail}`,
      { root, cause: 'yaml_parse_error', yamlPath, underlying: yamlErr },
    );
  }

  const parsed = PersistedContractYamlSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
    emitLayoutCorrupted(deps.audit, root, 'yaml_schema_invalid', detail);
    throw new ContractLayoutCorruptedError(
      `contract.yaml schema invalid at ${root}: ${detail}`,
      { root, cause: 'yaml_schema_invalid', yamlPath, issues: parsed.error.issues },
    );
  }
  const contract = parsed.data;

  if (expectedContract && contract.id !== expectedContract.id) {
    emitLayoutCorrupted(
      deps.audit,
      root,
      'yaml_id_mismatch',
      `expected=${expectedContract.id} actual=${contract.id}`,
    );
    throw new ContractLayoutCorruptedError(
      `contract.yaml id mismatch at ${root}: expected ${expectedContract.id}, got ${contract.id}`,
      { root, cause: 'yaml_id_mismatch', expectedId: expectedContract.id, actualId: contract.id },
    );
  }

  const yamlSubtaskIds = contract.subtasks.map(st => st.id);
  const uniqueYamlIds = new Set(yamlSubtaskIds);
  if (uniqueYamlIds.size !== yamlSubtaskIds.length) {
    emitLayoutCorrupted(deps.audit, root, 'duplicate_subtask_id_in_yaml', yamlSubtaskIds.join(','));
    throw new ContractLayoutCorruptedError(
      `duplicate subtask ids in contract.yaml at ${root}`,
      { root, cause: 'duplicate_subtask_id_in_yaml', yamlSubtaskIds },
    );
  }
  const expectedIds = uniqueYamlIds;

  const subtasksDir = getContractSubtasksDir(root);
  let entries: Awaited<ReturnType<FileSystem['list']>>;
  try {
    entries = await deps.fs.list(subtasksDir, { includeDirs: true });
  } catch (err) {
    if (isFileNotFound(err)) {
      emitLayoutCorrupted(
        deps.audit,
        root,
        'missing_subtasks_dir',
        `expected=${[...expectedIds].join(',')}`,
      );
      throw new ContractLayoutCorruptedError(
        `missing subtasks directory at ${subtasksDir}`,
        { root, cause: 'missing_subtasks_dir', expectedIds: [...expectedIds] },
      );
    }
    throw err;
  }

  const subtasks = new Map<string, SubtaskRuntimeRecord>();
  const seenFiles = new Set<string>();

  for (const entry of entries) {
    if (entry.isDirectory) {
      emitLayoutCorrupted(
        deps.audit,
        root,
        'subtasks_dir_contains_directory',
        `entry=${entry.name}`,
      );
      throw new ContractLayoutCorruptedError(
        `subtasks directory contains subdirectory at ${entry.path}`,
        { root, cause: 'subtasks_dir_contains_directory', entry: entry.name },
      );
    }

    if (!entry.name.endsWith('.json')) {
      emitLayoutCorrupted(
        deps.audit,
        root,
        'subtasks_dir_non_json_file',
        `entry=${entry.name}`,
      );
      throw new ContractLayoutCorruptedError(
        `subtasks directory contains non-json file at ${entry.path}`,
        { root, cause: 'subtasks_dir_non_json_file', entry: entry.name },
      );
    }

    const subtaskId = entry.name.slice(0, -'.json'.length);
    if (seenFiles.has(subtaskId)) {
      emitLayoutCorrupted(deps.audit, root, 'duplicate_subtask_file', `file=${entry.name}`);
      throw new ContractLayoutCorruptedError(
        `duplicate subtask file at ${entry.path}`,
        { root, cause: 'duplicate_subtask_file', entry: entry.name },
      );
    }
    seenFiles.add(subtaskId);

    if (!expectedIds.has(subtaskId)) {
      emitLayoutCorrupted(
        deps.audit,
        root,
        'unexpected_subtask_file',
        `file=${entry.name} expected=${[...expectedIds].join(',')}`,
      );
      throw new ContractLayoutCorruptedError(
        `unexpected subtask file ${entry.name} at ${subtasksDir}`,
        { root, cause: 'unexpected_subtask_file', entry: entry.name, expectedIds: [...expectedIds] },
      );
    }

    const filePath = path.join(subtasksDir, entry.name);
    let rawJson: unknown;
    try {
      rawJson = JSON.parse(await deps.fs.read(filePath));
    } catch (jsonErr) {
      const detail = `file=${entry.name} error=${formatErr(jsonErr)}`;
      emitLayoutCorrupted(deps.audit, root, 'subtask_parse_error', detail);
      throw new ContractLayoutCorruptedError(
        `subtask file parse error ${entry.name} at ${subtasksDir}`,
        { root, cause: 'subtask_parse_error', entry: entry.name, underlying: jsonErr },
      );
    }

    const recordParsed = SubtaskRuntimeRecordSchema.safeParse(rawJson);
    if (!recordParsed.success) {
      const detail = `file=${entry.name} issues=${recordParsed.error.issues.map(i => i.path.join('.')).join(';')}`;
      emitLayoutCorrupted(deps.audit, root, 'subtask_schema_invalid', detail);
      throw new ContractLayoutCorruptedError(
        `subtask file schema invalid ${entry.name} at ${subtasksDir}`,
        { root, cause: 'subtask_schema_invalid', entry: entry.name, issues: recordParsed.error.issues },
      );
    }
    const record = recordParsed.data;

    if (record.subtask_id !== subtaskId) {
      emitLayoutCorrupted(
        deps.audit,
        root,
        'subtask_id_mismatch',
        `file=${entry.name} record.subtask_id=${record.subtask_id}`,
      );
      throw new ContractLayoutCorruptedError(
        `subtask id mismatch in file ${entry.name} at ${subtasksDir}`,
        { root, cause: 'subtask_id_mismatch', entry: entry.name, expectedSubtaskId: subtaskId, actualSubtaskId: record.subtask_id },
      );
    }

    subtasks.set(subtaskId, record);
  }

  for (const id of expectedIds) {
    if (!subtasks.has(id)) {
      emitLayoutCorrupted(
        deps.audit,
        root,
        'missing_subtask_file',
        `missing=${id} expected=${[...expectedIds].join(',')}`,
      );
      throw new ContractLayoutCorruptedError(
        `missing subtask file for ${id} at ${subtasksDir}`,
        { root, cause: 'missing_subtask_file', missingSubtaskId: id, expectedIds: [...expectedIds] },
      );
    }
  }

  return { contract, subtasks };
}

// ============================================================================
// Public reader API
// ============================================================================

export async function readCurrentContractLayout(
  deps: { fs: FileSystem; audit: AuditLog },
): Promise<CurrentContractLayout | null> {
  const root = getContractActiveCurrentRoot();
  try {
    const { contract, subtasks } = await readContractLayoutAtRoot(deps, root);
    return {
      root,
      contract,
      subtasks,
      aggregate: deriveContractAggregate(subtasks),
    };
  } catch (err) {
    if (err instanceof ContractLayoutCorruptedError && err.context.cause === 'yaml_missing') {
      // Current slot simply does not exist yet — this is a typed null, not corruption.
      return null;
    }
    throw err;
  }
}

export function deriveContractAggregate(
  subtasks: ReadonlyMap<string, SubtaskRuntimeRecord>,
): ContractAggregateStatus {
  if (subtasks.size === 0) return 'pending';

  let allCompleted = true;
  for (const record of subtasks.values()) {
    if (record.status === 'verifying') return 'running';
    if (record.status !== 'completed') allCompleted = false;
  }
  return allCompleted ? 'completed' : 'pending';
}

export function deriveSubtaskRetrySummary(
  record: SubtaskRuntimeRecord,
): SubtaskRetrySummary {
  const rejected = record.attempts.filter(a => a.status === 'rejected');
  if (rejected.length === 0) return { retryCount: 0 };

  const sorted = [...rejected].sort((a, b) =>
    (a.finished_at ?? '').localeCompare(b.finished_at ?? ''),
  );
  const last = sorted[sorted.length - 1];
  return {
    retryCount: rejected.length,
    lastFailure: {
      attemptId: last.id,
      finishedAt: last.finished_at!,
      feedback: last.feedback,
      cause: last.cause,
    },
  };
}

// ============================================================================
// Step D: staging prepare / commit / cleanup
// ============================================================================

export async function prepareContractStaging(
  deps: { fs: FileSystem; audit: AuditLog },
  input: { creationId: string; contract: PersistedContractYaml },
): Promise<PreparedStaging> {
  const { creationId, contract } = input;
  const root = getContractStagingRoot(creationId);

  const parse = PersistedContractYamlSchema.safeParse(contract);
  if (!parse.success) {
    const detail = parse.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
    deps.audit.write(
      CONTRACT_AUDIT_EVENTS.CONTRACT_YAML_SCHEMA_INVALID,
      `creationId=${creationId}`,
      `reason=schema_invalid`,
      `detail=${deps.audit.preview(detail)}`,
    );
    throw new ContractStagingCorruptedError(
      `invalid persisted contract yaml for creation ${creationId}: ${detail}`,
      { creationId, root, cause: 'input_schema_invalid', issues: parse.error.issues },
    );
  }

  if (await deps.fs.exists(root)) {
    throw new ContractStagingCorruptedError(
      `staging root already exists: ${root}`,
      { creationId, root, cause: 'staging_already_exists' },
    );
  }

  const subtasksDir = getContractSubtasksDir(root);
  let prepared = false;

  try {
    await deps.fs.writeAtomic(getContractYamlPath(root), yaml.dump(contract));

    for (const st of contract.subtasks) {
      const record: SubtaskRuntimeRecord = {
        schema_version: 1,
        subtask_id: st.id,
        status: 'todo',
        attempts: [],
      };
      await deps.fs.writeAtomic(
        path.join(subtasksDir, `${st.id}.json`),
        JSON.stringify(record, null, 2),
      );
    }

    // Readback verification against the contract we intended to write.
    await readContractLayoutAtRoot(deps, root, contract);
    prepared = true;
  } catch (err) {
    const cleanupErrors: string[] = [];
    try {
      await deps.fs.removeDir(root);
    } catch (cleanupErr) {
      cleanupErrors.push(formatErr(cleanupErr));
    }
    throw new ContractStagingCorruptedError(
      `failed to prepare staging ${creationId}: ${formatErr(err)}`,
      { creationId, root, cause: 'prepare_failed', underlying: err, cleanupErrors },
    );
  }

  if (!prepared) {
    // Defensive: readback should have thrown if verification failed.
    throw new ContractStagingCorruptedError(
      `staging ${creationId} readback verification failed`,
      { creationId, root, cause: 'readback_failed' },
    );
  }

  return { creationId, root };
}

export async function commitContractStaging(
  deps: { fs: FileSystem; audit: AuditLog },
  prepared: PreparedStaging,
): Promise<void> {
  const { creationId, root } = prepared;
  const currentRoot = getContractActiveCurrentRoot();

  try {
    await deps.fs.move(root, currentRoot);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST' || code === 'ENOTEMPTY') {
      throw new ActiveContractSlotOccupiedError(currentRoot, creationId, err);
    }
    throw err;
  }

  try {
    const layout = await readCurrentContractLayout(deps);
    if (layout === null) {
      emitLayoutCorrupted(deps.audit, currentRoot, 'committed_but_missing');
      throw new ContractLayoutCorruptedError(
        `committed contract disappeared from ${currentRoot}`,
        { root: currentRoot, cause: 'committed_but_missing' },
      );
    }
  } catch (layoutErr) {
    if (layoutErr instanceof ContractLayoutCorruptedError) {
      // Already emitted; do not roll back the rename.
      throw layoutErr;
    }
    const detail = formatErr(layoutErr);
    emitLayoutCorrupted(deps.audit, currentRoot, 'committed_but_invalid', detail);
    throw new ContractLayoutCorruptedError(
      `committed contract at ${currentRoot} is invalid: ${detail}`,
      { root: currentRoot, cause: 'committed_but_invalid', underlying: layoutErr },
    );
  }
}

export async function cleanupAbandonedContractStaging(
  deps: { fs: FileSystem; audit: AuditLog },
): Promise<{ removed: string[]; failed: Array<{ creationId: string; reason: string }> }> {
  const removed: string[] = [];
  const failed: Array<{ creationId: string; reason: string }> = [];

  let entries: Awaited<ReturnType<FileSystem['list']>>;
  try {
    entries = await deps.fs.list(CONTRACT_STAGING_DIR, { includeDirs: true });
  } catch (err) {
    if (isFileNotFound(err)) return { removed: [], failed: [] };
    throw err;
  }

  for (const entry of entries) {
    const creationId = entry.name;
    if (!entry.isDirectory) {
      emitLayoutCorrupted(
        deps.audit,
        entry.path,
        'non_directory_staging_entry',
        `name=${entry.name}`,
      );
      failed.push({
        creationId,
        reason: `staging entry is not a directory: ${entry.path}`,
      });
      continue;
    }

    deps.audit.write(
      CONTRACT_AUDIT_EVENTS.STAGING_CLEANUP,
      `creationId=${creationId}`,
      `root=${entry.path}`,
    );

    try {
      await deps.fs.removeDir(entry.path);
      removed.push(creationId);
    } catch (err) {
      const reason = formatErr(err);
      failed.push({ creationId, reason });
    }
  }

  return { removed, failed };
}
