/**
 * @module L4.ContractSystem.ArchivePayloadLayout
 * Phase 1193 Step B: archive current-format payload strict reader and projection.
 *
 * Owns the read-only interpretation of archive payloads that use the current
 * format (contract.yaml + subtasks/*.json). Active runtime no longer uses this
 * layout; it is preserved only for archive compatibility.
 */

import * as path from 'path';
import * as yaml from 'js-yaml';
import { isFileNotFound, type FileSystem } from '../../foundation/fs/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { formatErr } from '../../foundation/node-utils/index.js';
import { CONTRACT_AUDIT_EVENTS } from './audit-events.js';
import { CONTRACT_SUBTASKS_DIR, CONTRACT_YAML_FILE } from './dirs.js';
import {
  PersistedContractYamlSchema,
  SubtaskRuntimeRecordSchema,
} from './schemas.js';
import type {
  PersistedContractYaml,
  SubtaskRuntimeRecord,
  Contract,
  ProgressData,
  SubtaskStatus,
  DerivableStatus,
  ContractId,
} from './types.js';
import { ContractLayoutCorruptedError } from './errors.js';

type ContractAggregateStatus = 'pending' | 'running' | 'completed';

interface ArchivePayloadLayoutSnapshot {
  root: string;
  contract: PersistedContractYaml;
  subtasks: ReadonlyMap<string, SubtaskRuntimeRecord>;
  aggregate: ContractAggregateStatus;
}

interface SubtaskRetrySummary {
  retryCount: number;
  lastFailure?: {
    attemptId: string;
    finishedAt: string;
    feedback?: string;
    cause?: string;
  };
}

// ============================================================================
// Path helpers (relative to the FileSystem baseDir)
// ============================================================================

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
    detail ? `detail=${typeof audit.preview === 'function' ? audit.preview(detail) : detail}` : '',
  );
}

// ============================================================================
// Strict current-format payload reader
// ============================================================================

export async function readStrictContractLayoutAtRoot(
  deps: { fs: FileSystem; audit: AuditLog },
  root: string,
  expectedContractId?: ContractId,
): Promise<ArchivePayloadLayoutSnapshot> {
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

  if (expectedContractId !== undefined && contract.id !== expectedContractId) {
    emitLayoutCorrupted(
      deps.audit,
      root,
      'yaml_id_mismatch',
      `expected=${expectedContractId} actual=${contract.id}`,
    );
    throw new ContractLayoutCorruptedError(
      `contract.yaml id mismatch at ${root}: expected ${expectedContractId}, got ${contract.id}`,
      { root, cause: 'yaml_id_mismatch', expectedId: expectedContractId, actualId: contract.id },
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

  return {
    root,
    contract,
    subtasks,
    aggregate: deriveContractAggregate(subtasks),
  };
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
// Runtime projection
// ============================================================================

export interface ArchivePayloadRuntimeView {
  contract: Contract;
  progress: ProgressData;
}

function mapSubtaskRuntimeStatusToProgress(status: SubtaskRuntimeRecord['status']): SubtaskStatus {
  switch (status) {
    case 'todo':
      return 'todo';
    case 'verifying':
      return 'in_progress';
    case 'completed':
      return 'completed';
    default:
      // Runtime status is schema-validated; this branch is defensive.
      return 'todo';
  }
}

function mapContractAggregateToDerivable(aggregate: ContractAggregateStatus): DerivableStatus {
  return aggregate;
}

function toLastFailedCause(cause?: SubtaskRuntimeRecord['attempts'][number]['cause']): NonNullable<ProgressData['subtasks'][string]['last_failed_feedback']>['cause'] {
  if (
    cause === 'llm_rejected' ||
    cause === 'programming_bug' ||
    cause === 'subagent_timeout' ||
    cause === 'script_failed'
  ) {
    return cause;
  }
  // 'daemon_restart' and undefined are not part of the legacy feedback vocabulary;
  // map to a generic rejection cause rather than inventing a new persisted value.
  return 'llm_rejected';
}

function deriveSubtaskProgress(record: SubtaskRuntimeRecord): ProgressData['subtasks'][string] {
  const rejected = record.attempts.filter(a => a.status === 'rejected');
  const lastRejected = rejected.length > 0
    ? rejected.reduce((latest, a) =>
        (a.finished_at ?? '') >= (latest.finished_at ?? '') ? a : latest,
      )
    : undefined;

  return {
    status: mapSubtaskRuntimeStatusToProgress(record.status),
    completed_at: record.completed_at,
    evidence: record.evidence,
    artifacts: record.artifacts,
    force_accepted: record.force_accepted,
    retry_count: rejected.length,
    last_failed_feedback: lastRejected
      ? {
          feedback: lastRejected.feedback ?? '',
          cause: toLastFailedCause(lastRejected.cause),
        }
      : undefined,
    verification_attempt_id: record.status === 'verifying' ? record.current_attempt_id : undefined,
  };
}

function earliestAttemptStartedAt(record: SubtaskRuntimeRecord): string | undefined {
  if (record.attempts.length === 0) return undefined;
  return record.attempts
    .map(a => a.started_at)
    .sort()[0];
}

function latestActivityTimestamp(record: SubtaskRuntimeRecord): string | undefined {
  const times: string[] = [];
  for (const a of record.attempts) {
    if (a.finished_at) times.push(a.finished_at);
    times.push(a.started_at);
  }
  if (record.completed_at) times.push(record.completed_at);
  if (times.length === 0) return undefined;
  return times.sort()[times.length - 1];
}

/**
 * Project a strict archive payload layout into the existing runtime view
 * (`Contract` + `ProgressData`) consumed by archive readers.
 */
export function projectArchivePayloadRuntime(layout: ArchivePayloadLayoutSnapshot): ArchivePayloadRuntimeView {
  const progressStatus = mapContractAggregateToDerivable(layout.aggregate);

  const subtasks: ProgressData['subtasks'] = {};
  for (const st of layout.contract.subtasks) {
    const record = layout.subtasks.get(st.id);
    if (!record) {
      // Strict reader already guarantees every yaml subtask has a record.
      throw new ContractLayoutCorruptedError(
        `subtask record missing for ${st.id} during projection`,
        { root: layout.root, cause: 'projection_missing_subtask_record', subtaskId: st.id },
      );
    }
    subtasks[st.id] = deriveSubtaskProgress(record);
  }

  const progress: ProgressData = {
    schema_version: 1,
    contract_id: layout.contract.id as any,
    status: progressStatus,
    subtasks,
    checkpoint: undefined,
  };

  const contractSubtasks: Contract['subtasks'] = layout.contract.subtasks.map(st => {
    const record = layout.subtasks.get(st.id)!;
    const createdAt = earliestAttemptStartedAt(record);
    const updatedAt = latestActivityTimestamp(record);
    return {
      id: st.id,
      description: st.description,
      status: subtasks[st.id].status,
      created_at: createdAt ?? '',
      updated_at: updatedAt ?? '',
      completed_at: record.completed_at,
    };
  });

  const earliestSubtaskCreated = contractSubtasks
    .map(st => st.created_at)
    .filter((t): t is string => t.length > 0)
    .sort()[0];

  const contract: Contract = {
    id: layout.contract.id,
    title: layout.contract.title,
    description: layout.contract.goal,
    status: progressStatus,
    priority: 'normal',
    creator: 'system',
    goal: layout.contract.goal,
    subtasks: contractSubtasks,
    auth_level: layout.contract.auth_level ?? 'auto',
    created_at: earliestSubtaskCreated ?? '',
    updated_at: earliestSubtaskCreated ?? '',
    completed_at: progressStatus === 'completed' ? earliestSubtaskCreated ?? '' : undefined,
  };

  return { contract, progress };
}
