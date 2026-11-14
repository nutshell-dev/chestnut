import type {
  ExecutionIdentity,
  ExecutionTerminationTrigger,
  ProcessEvidence,
} from '../../foundation/process-exec/index.js';
import { formatErr } from '../../foundation/node-utils/index.js';

export const MIGRATED_EXEC_RESULT_VERSION = 1 as const;

export type MigratedExecResultClassification =
  | 'success'
  | 'nonzero_exit'
  | 'timeout'
  | 'max_buffer'
  | 'abort'
  | 'error';

export interface MigratedExecTerminationRecord {
  status: 'gone' | 'still_alive' | 'indeterminate';
  trigger: ExecutionTerminationTrigger;
  termSent: boolean;
  killSent: boolean;
  identity?: ExecutionIdentity;
  reason?: string;
  completedAt?: string;
  checkedAt?: string;
}

export const MIGRATED_EXEC_TERMINAL_INTENT_VERSION = 1 as const;

export type MigratedExecTerminalIntentStage =
  | 'result_dir_create'
  | 'result_initial_write'
  | 'short_id_index_add'
  | 'short_id_index_save'
  | 'identity_checkpoint_audit'
  | 'migration_index_save';

/**
 * Durable cleanup intent for a checkpointed command whose normal execution
 * chain could not commit a terminal record. It is not itself a terminal fact:
 * recovery must observe/confirm gone before writing exit.json and moving failed.
 */
export interface MigratedExecTerminalIntent {
  version: typeof MIGRATED_EXEC_TERMINAL_INTENT_VERSION;
  stage: MigratedExecTerminalIntentStage;
  error: string;
  termination: MigratedExecTerminationRecord;
  evidence?: ProcessEvidence;
}

export class MigratedExecTerminalIntentDecodeError extends Error {
  constructor(
    readonly kind: 'malformed' | 'future_version',
    detail: string,
    options?: ErrorOptions,
  ) {
    super(`Invalid migrated exec terminal intent (${kind}): ${detail}`, options);
    this.name = 'MigratedExecTerminalIntentDecodeError';
  }
}

/** Versioned terminal fact for a migrated exec. result.txt is already durable before this commit. */
export interface MigratedExecResultRecord {
  version: typeof MIGRATED_EXEC_RESULT_VERSION;
  taskId: string;
  completedAt: string;
  classification: MigratedExecResultClassification;
  exitCode?: number | null;
  stderr?: string;
  signal?: string;
  termination?: MigratedExecTerminationRecord;
  evidence?: ProcessEvidence;
}

export interface LegacyMigratedExecResultRecord {
  completedAt: string;
}

export type DecodedMigratedExecResult =
  | { kind: 'v1'; record: MigratedExecResultRecord }
  | { kind: 'legacy'; record: LegacyMigratedExecResultRecord };

export class MigratedExecResultDecodeError extends Error {
  constructor(
    readonly kind: 'malformed' | 'future_version',
    detail: string,
    options?: ErrorOptions,
  ) {
    super(`Invalid migrated exec exit.json (${kind}): ${detail}`, options);
    this.name = 'MigratedExecResultDecodeError';
  }
}

function malformed(detail: string, cause?: unknown): MigratedExecResultDecodeError {
  return new MigratedExecResultDecodeError('malformed', detail, cause === undefined ? undefined : { cause });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw malformed(`${field} must be a non-empty string`);
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, field);
}

function decodeIdentity(value: unknown): ExecutionIdentity | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value) || !Number.isInteger(value.leaderPid) || !Number.isInteger(value.processGroupId)) {
    throw malformed('termination.identity must contain integer leaderPid/processGroupId');
  }
  return { leaderPid: value.leaderPid as number, processGroupId: value.processGroupId as number };
}

function decodeTermination(value: unknown): MigratedExecTerminationRecord | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) throw malformed('termination must be an object');
  if (!['gone', 'still_alive', 'indeterminate'].includes(value.status as string)) {
    throw malformed('termination.status is invalid');
  }
  if (!['timeout', 'max_buffer', 'abort', 'caller_requested'].includes(value.trigger as string)) {
    throw malformed('termination.trigger is invalid');
  }
  if (typeof value.termSent !== 'boolean' || typeof value.killSent !== 'boolean') {
    throw malformed('termination.termSent/killSent must be boolean');
  }
  return {
    status: value.status as MigratedExecTerminationRecord['status'],
    trigger: value.trigger as ExecutionTerminationTrigger,
    termSent: value.termSent,
    killSent: value.killSent,
    identity: decodeIdentity(value.identity),
    reason: optionalString(value.reason, 'termination.reason'),
    completedAt: optionalString(value.completedAt, 'termination.completedAt'),
    checkedAt: optionalString(value.checkedAt, 'termination.checkedAt'),
  };
}

function decodeEvidence(value: unknown): ProcessEvidence | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value) || value.version !== 1 || typeof value.atMs !== 'number' || !Array.isArray(value.facts)) {
    throw malformed('evidence must be a version 1 ProcessEvidence object');
  }
  return value as unknown as ProcessEvidence;
}

export function decodeMigratedExecTerminalIntent(value: unknown): MigratedExecTerminalIntent {
  if (!isObject(value)) throw new MigratedExecTerminalIntentDecodeError('malformed', 'root must be an object');
  if (typeof value.version === 'number' && value.version > MIGRATED_EXEC_TERMINAL_INTENT_VERSION) {
    throw new MigratedExecTerminalIntentDecodeError('future_version', `version=${value.version}`);
  }
  if (value.version !== MIGRATED_EXEC_TERMINAL_INTENT_VERSION) {
    throw new MigratedExecTerminalIntentDecodeError('malformed', `unsupported version=${String(value.version)}`);
  }
  const stage = requiredString(value.stage, 'stage') as MigratedExecTerminalIntentStage;
  if (!['result_dir_create', 'result_initial_write', 'short_id_index_add', 'short_id_index_save', 'identity_checkpoint_audit', 'migration_index_save'].includes(stage)) {
    throw new MigratedExecTerminalIntentDecodeError('malformed', `invalid stage=${stage}`);
  }
  try {
    return {
      version: MIGRATED_EXEC_TERMINAL_INTENT_VERSION,
      stage,
      error: requiredString(value.error, 'error'),
      termination: decodeTermination(value.termination) ?? (() => {
        throw new MigratedExecTerminalIntentDecodeError('malformed', 'termination is required');
      })(),
      evidence: decodeEvidence(value.evidence),
    };
  } catch (err) {
    if (err instanceof MigratedExecTerminalIntentDecodeError) throw err;
    throw new MigratedExecTerminalIntentDecodeError('malformed', formatErr(err), { cause: err });
  }
}


export function encodeMigratedExecResult(record: MigratedExecResultRecord): string {
  return JSON.stringify(record);
}

/** Strict v1 decoder plus the historical clean-exit {completedAt} compatibility branch. */
export function decodeMigratedExecResult(content: string, expectedTaskId?: string): DecodedMigratedExecResult {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (err) {
    throw malformed('invalid JSON', err);
  }
  if (!isObject(value)) throw malformed('root must be an object');

  if (value.version === undefined) {
    return { kind: 'legacy', record: { completedAt: requiredString(value.completedAt, 'completedAt') } };
  }
  if (typeof value.version === 'number' && value.version > MIGRATED_EXEC_RESULT_VERSION) {
    throw new MigratedExecResultDecodeError('future_version', `version=${value.version}`);
  }
  if (value.version !== MIGRATED_EXEC_RESULT_VERSION) throw malformed(`unsupported version=${String(value.version)}`);

  const taskId = requiredString(value.taskId, 'taskId');
  if (expectedTaskId !== undefined && taskId !== expectedTaskId) {
    throw malformed(`taskId mismatch: expected=${expectedTaskId} actual=${taskId}`);
  }
  const classification = requiredString(value.classification, 'classification') as MigratedExecResultClassification;
  if (!['success', 'nonzero_exit', 'timeout', 'max_buffer', 'abort', 'error'].includes(classification)) {
    throw malformed(`invalid classification=${classification}`);
  }
  if (value.exitCode !== undefined && value.exitCode !== null
    && (typeof value.exitCode !== 'number' || !Number.isInteger(value.exitCode))) {
    throw malformed('exitCode must be an integer, null, or absent');
  }

  const record: MigratedExecResultRecord = {
    version: MIGRATED_EXEC_RESULT_VERSION,
    taskId,
    completedAt: requiredString(value.completedAt, 'completedAt'),
    classification,
    exitCode: value.exitCode as number | null | undefined,
    stderr: value.stderr === undefined ? undefined : (() => {
      if (typeof value.stderr !== 'string') throw malformed('stderr must be a string');
      return value.stderr;
    })(),
    signal: optionalString(value.signal, 'signal'),
    termination: decodeTermination(value.termination),
    evidence: decodeEvidence(value.evidence),
  };
  return { kind: 'v1', record };
}
