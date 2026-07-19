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
import type {
  VerificationAttemptTransition,
  TransitionApplicationResult,
  VerificationTransitionResult,
} from './verification-transition-types.js';
import type { PersistedContractYaml, SubtaskRuntimeRecord, Contract, ProgressData, SubtaskStatus, DerivableStatus, ContractId } from './types.js';
import { ContractProgressInvariantViolatedError } from './types.js';
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
    detail ? `detail=${typeof audit.preview === 'function' ? audit.preview(detail) : detail}` : '',
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
  // Phase 1135: an empty current slot must not emit a corruption audit event.
  if (!(await deps.fs.exists(root))) return null;

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
      // Current slot exists but has no yaml — this is corruption (empty directory).
      throw err;
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

// ============================================================================
// Phase 1136 Step A: verification attempt transition state machine
// ============================================================================

function cloneRecord(record: SubtaskRuntimeRecord): SubtaskRuntimeRecord {
  return JSON.parse(JSON.stringify(record));
}

function findRunningAttempt(
  record: SubtaskRuntimeRecord,
  attemptId: string,
): { index: number; attempt: SubtaskRuntimeRecord['attempts'][number] } | undefined {
  const index = record.attempts.findIndex(a => a.id === attemptId);
  if (index === -1) return undefined;
  const attempt = record.attempts[index];
  if (attempt.status !== 'running') return undefined;
  return { index, attempt };
}

export function applyVerificationAttemptTransition(
  existing: SubtaskRuntimeRecord,
  transition: VerificationAttemptTransition,
): TransitionApplicationResult {
  const record = cloneRecord(existing);

  switch (transition.kind) {
    case 'start': {
      if (record.status !== 'todo') {
        return { success: false, reason: `start requires subtask status "todo", got "${record.status}"` };
      }
      if (record.attempts.some(a => a.id === transition.attemptId)) {
        return { success: false, reason: `attempt id ${transition.attemptId} already exists` };
      }
      record.attempts.push({
        id: transition.attemptId,
        status: 'running',
        started_at: transition.at,
        evidence: transition.evidence,
        artifacts: transition.artifacts,
      });
      record.status = 'verifying';
      record.current_attempt_id = transition.attemptId;
      record.evidence = transition.evidence;
      record.artifacts = transition.artifacts;
      return { success: true, record };
    }
    case 'pass': {
      if (record.status !== 'verifying') {
        return { success: false, reason: `pass requires subtask status "verifying", got "${record.status}"` };
      }
      if (record.current_attempt_id !== transition.attemptId) {
        return { success: false, reason: `expected attempt ${record.current_attempt_id}, got ${transition.attemptId}` };
      }
      const found = findRunningAttempt(record, transition.attemptId);
      if (!found) {
        return { success: false, reason: `no running attempt ${transition.attemptId} to pass` };
      }
      found.attempt.status = 'passed';
      found.attempt.finished_at = transition.at;
      record.status = 'completed';
      record.completed_at = transition.at;
      delete record.current_attempt_id;
      return { success: true, record };
    }
    case 'reject': {
      if (record.status !== 'verifying') {
        return { success: false, reason: `reject requires subtask status "verifying", got "${record.status}"` };
      }
      if (record.current_attempt_id !== transition.attemptId) {
        return { success: false, reason: `expected attempt ${record.current_attempt_id}, got ${transition.attemptId}` };
      }
      const found = findRunningAttempt(record, transition.attemptId);
      if (!found) {
        return { success: false, reason: `no running attempt ${transition.attemptId} to reject` };
      }
      found.attempt.status = 'rejected';
      found.attempt.finished_at = transition.at;
      found.attempt.feedback = transition.feedback;
      found.attempt.cause = transition.cause;
      if (transition.forceAccept) {
        record.status = 'completed';
        record.completed_at = transition.at;
        record.force_accepted = true;
      } else {
        record.status = 'todo';
        delete record.completed_at;
      }
      delete record.current_attempt_id;
      return { success: true, record };
    }
    case 'interrupt': {
      if (record.status !== 'verifying') {
        return { success: false, reason: `interrupt requires subtask status "verifying", got "${record.status}"` };
      }
      if (record.current_attempt_id !== transition.attemptId) {
        return { success: false, reason: `expected attempt ${record.current_attempt_id}, got ${transition.attemptId}` };
      }
      const found = findRunningAttempt(record, transition.attemptId);
      if (!found) {
        return { success: false, reason: `no running attempt ${transition.attemptId} to interrupt` };
      }
      found.attempt.status = 'interrupted';
      found.attempt.finished_at = transition.at;
      if (transition.cause !== undefined) {
        found.attempt.cause = transition.cause;
      }
      if (transition.feedback !== undefined) {
        found.attempt.feedback = transition.feedback;
      }
      record.status = 'todo';
      delete record.completed_at;
      delete record.current_attempt_id;
      return { success: true, record };
    }
    default: {
      // Exhaustiveness guard; unreachable if the union is complete.
      return { success: false, reason: 'unknown transition kind' };
    }
  }
}

/**
 * Apply a typed verification attempt transition to a single subtask in the
 * active/current layout and persist it atomically.
 *
 * Returns:
 * - 'updated' with the new record when the transition commits.
 * - 'skipped' when the transition is illegal (wrong status, duplicate id, etc.).
 * - 'late' when the attempt id does not match the current running attempt.
 */
export async function transitionCurrentVerificationAttempt(
  deps: { fs: FileSystem; audit: AuditLog },
  contractId: ContractId,
  subtaskId: string,
  transition: VerificationAttemptTransition,
): Promise<VerificationTransitionResult> {
  const layout = await readCurrentContractLayout(deps);
  assertCurrentLayoutMatches(layout, contractId);

  if (!layout.contract.subtasks.some(st => st.id === subtaskId)) {
    return { kind: 'skipped', reason: `subtask ${subtaskId} is not defined in contract.yaml` };
  }

  const existing = layout.subtasks.get(subtaskId);
  if (!existing) {
    return { kind: 'skipped', reason: `subtask record ${subtaskId} is missing` };
  }

  const applied = applyVerificationAttemptTransition(existing, transition);
  if (!applied.success) {
    return { kind: 'skipped', reason: applied.reason };
  }

  await writeCurrentSubtaskRecord(deps, { contractId, subtaskId, record: applied.record });
  return { kind: 'updated', record: applied.record, prior: existing };
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
// Phase 1135 Step B: current layout runtime projection
// ============================================================================

export interface CurrentContractRuntimeView {
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
 * Project a strict `CurrentContractLayout` into the existing runtime view
 * (`Contract` + `ProgressData`) consumed by manager callers.
 *
 * All fields are derived from the YAML, subtask files, or the aggregate; no
 * progress.json is read and no new persistent fields are invented.
 */
export function projectCurrentRuntime(layout: CurrentContractLayout): CurrentContractRuntimeView {
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

// ============================================================================
// Phase 1135 Step C: atomic current subtask persistence boundary
// ============================================================================

const ALLOWED_SUBTASK_PROGRESS_FIELDS = new Set([
  'status',
  'completed_at',
  'evidence',
  'artifacts',
  'force_accepted',
  'verification_attempt_id',
]);

function mapSubtaskProgressStatusToRuntime(
  status: ProgressData['subtasks'][string]['status'],
): SubtaskRuntimeRecord['status'] {
  switch (status) {
    case 'todo':
      return 'todo';
    case 'in_progress':
      return 'verifying';
    case 'completed':
      return 'completed';
    default:
      return 'todo';
  }
}

function buildRuntimeRecordFromProgress(
  existing: SubtaskRuntimeRecord,
  input: ProgressData['subtasks'][string],
  subtaskId: string,
): SubtaskRuntimeRecord {
  const newStatus = mapSubtaskProgressStatusToRuntime(input.status);
  const record: SubtaskRuntimeRecord = {
    schema_version: 1,
    subtask_id: subtaskId,
    status: newStatus,
    attempts: existing.attempts,
    completed_at: input.completed_at,
    evidence: input.evidence,
    artifacts: input.artifacts,
    force_accepted: input.force_accepted,
  };
  if (newStatus === 'verifying') {
    record.current_attempt_id = input.verification_attempt_id;
  }
  return record;
}

function assertCurrentLayoutMatches(
  layout: CurrentContractLayout | null,
  contractId: ContractId,
): asserts layout is CurrentContractLayout {
  if (!layout) {
    throw new ContractLayoutCorruptedError(
      `active/current slot is empty; cannot write subtask for ${contractId}`,
      { root: getContractActiveCurrentRoot(), cause: 'yaml_missing', contractId },
    );
  }
  if (layout.contract.id !== contractId) {
    throw new ContractLayoutCorruptedError(
      `active/current contract id mismatch: expected ${contractId}, got ${layout.contract.id}`,
      { root: layout.root, cause: 'yaml_id_mismatch', expectedId: contractId, actualId: layout.contract.id },
    );
  }
}

/**
 * Write a single subtask runtime record to `active/current/subtasks/<id>.json`.
 *
 * Validates the current layout (YAML id, subtask membership, record id) and
 * performs an atomic write + readback verification.
 */
export async function writeCurrentSubtaskRecord(
  deps: { fs: FileSystem; audit: AuditLog },
  input: { contractId: ContractId; subtaskId: string; record: SubtaskRuntimeRecord },
): Promise<void> {
  const { contractId, subtaskId, record } = input;
  const layout = await readCurrentContractLayout(deps);
  assertCurrentLayoutMatches(layout, contractId);

  if (!layout.contract.subtasks.some(st => st.id === subtaskId)) {
    throw new ContractProgressInvariantViolatedError(
      `subtask ${subtaskId} is not defined in contract.yaml`,
      { contractId, issuePath: subtaskId },
    );
  }

  if (record.subtask_id !== subtaskId) {
    throw new ContractProgressInvariantViolatedError(
      `subtask record id mismatch: expected ${subtaskId}, got ${record.subtask_id}`,
      { contractId, issuePath: 'subtask_id' },
    );
  }

  const filePath = path.join(getContractSubtasksDir(layout.root), `${subtaskId}.json`);
  await deps.fs.writeAtomic(filePath, JSON.stringify(record, null, 2));

  // Readback verification.
  let raw: string;
  try {
    raw = await deps.fs.read(filePath);
  } catch (err) {
    deps.audit.write(
      CONTRACT_AUDIT_EVENTS.LAYOUT_CORRUPTED,
      `root=${layout.root}`,
      `cause=subtask_readback_failed`,
      `subtaskId=${subtaskId}`,
      `error=${formatErr(err)}`,
    );
    throw new ContractLayoutCorruptedError(
      `subtask ${subtaskId} readback failed after write at ${layout.root}`,
      { root: layout.root, cause: 'subtask_readback_failed', subtaskId, underlying: err },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    deps.audit.write(
      CONTRACT_AUDIT_EVENTS.LAYOUT_CORRUPTED,
      `root=${layout.root}`,
      `cause=subtask_readback_parse_error`,
      `subtaskId=${subtaskId}`,
      `error=${formatErr(err)}`,
    );
    throw new ContractLayoutCorruptedError(
      `subtask ${subtaskId} readback parse error at ${layout.root}`,
      { root: layout.root, cause: 'subtask_readback_parse_error', subtaskId, underlying: err },
    );
  }

  const validated = SubtaskRuntimeRecordSchema.safeParse(parsed);
  if (!validated.success) {
    const detail = validated.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
    deps.audit.write(
      CONTRACT_AUDIT_EVENTS.LAYOUT_CORRUPTED,
      `root=${layout.root}`,
      `cause=subtask_readback_schema_invalid`,
      `subtaskId=${subtaskId}`,
      `detail=${typeof deps.audit.preview === 'function' ? deps.audit.preview(detail) : detail}`,
    );
    throw new ContractLayoutCorruptedError(
      `subtask ${subtaskId} readback schema invalid at ${layout.root}: ${detail}`,
      { root: layout.root, cause: 'subtask_readback_schema_invalid', subtaskId, issues: validated.error.issues },
    );
  }
}

/**
 * Adapter for callers that still pass a whole `ProgressData`.
 *
 * Compares the caller's input against the current disk snapshot and only
 * allows a single subtask to change, and only via the allowed progress fields.
 * Does not loop-rewrite every subtask file.
 */
export async function saveCurrentProgressAtomic(
  deps: { fs: FileSystem; audit: AuditLog },
  contractId: ContractId,
  progress: ProgressData,
): Promise<void> {
  const layout = await readCurrentContractLayout(deps);
  assertCurrentLayoutMatches(layout, contractId);

  const snapshot = projectCurrentRuntime(layout).progress;

  if (progress.contract_id !== contractId) {
    throw new ContractProgressInvariantViolatedError(
      `contract_id in progress does not match current contract ${contractId}`,
      { contractId, issuePath: 'contract_id' },
    );
  }

  const changedSubtaskIds = Object.keys(progress.subtasks).filter(id => {
    const a = JSON.stringify(progress.subtasks[id]);
    const b = JSON.stringify(snapshot.subtasks[id]);
    return a !== b;
  });

  if (changedSubtaskIds.length === 0) {
    return;
  }

  if (changedSubtaskIds.length > 1) {
    throw new ContractProgressInvariantViolatedError(
      `current layout only supports single-subtask writes; ${changedSubtaskIds.length} subtasks changed`,
      { contractId, issuePath: changedSubtaskIds.join(',') },
    );
  }

  const subtaskId = changedSubtaskIds[0];
  const inputSubtask = progress.subtasks[subtaskId];
  const snapshotSubtask = snapshot.subtasks[subtaskId];

  for (const key of Object.keys(inputSubtask)) {
    if (ALLOWED_SUBTASK_PROGRESS_FIELDS.has(key)) continue;
    const inputValue = (inputSubtask as Record<string, unknown>)[key];
    const snapshotValue = (snapshotSubtask as Record<string, unknown>)[key];
    if (JSON.stringify(inputValue) !== JSON.stringify(snapshotValue)) {
      throw new ContractProgressInvariantViolatedError(
        `field '${key}' is not allowed to change for current subtask ${subtaskId}`,
        { contractId, issuePath: `${subtaskId}.${key}` },
      );
    }
  }

  const existingRecord = layout.subtasks.get(subtaskId);
  if (!existingRecord) {
    // Strict reader guarantees this cannot happen.
    throw new ContractLayoutCorruptedError(
      `subtask record missing for ${subtaskId} during save`,
      { root: layout.root, cause: 'projection_missing_subtask_record', subtaskId },
    );
  }

  const updatedRecord = buildRuntimeRecordFromProgress(existingRecord, inputSubtask, subtaskId);
  await writeCurrentSubtaskRecord(deps, { contractId, subtaskId, record: updatedRecord });
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
      `detail=${typeof deps.audit.preview === 'function' ? deps.audit.preview(detail) : detail}`,
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
