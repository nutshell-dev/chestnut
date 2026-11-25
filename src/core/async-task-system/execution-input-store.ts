/**
 * Phase 2248 F: immutable execution-input sidecars bound to the original task bytes.
 *
 * This store never rewrites task files or prepared claims. The conditional commit
 * is a local read/compare/no-replace protocol, not a cross-process CAS claim.
 */

import { isFileNotFound, type FileSystem } from '../../foundation/fs/index.js';
import { sha256Hex } from '../../foundation/node-utils/index.js';
import {
  TASKS_QUEUES_PENDING_DIR,
  TASKS_QUEUES_RUNNING_DIR,
  TASKS_QUEUES_RESULTS_DIR,
} from './dirs.js';
import { isExecutionInputJsonValue, SubAgentTaskSchema } from './task-schemas.js';
import {
  adoptLegacyFullTaskId,
  type CommitPreparedExecutionInput,
  type FullTaskId,
  type PreparedExecutionInputRecord,
  type SubAgentTask,
  type TaskExecutionInputStore,
  type UnpreparedExecutionInput,
} from './types.js';

export const EXECUTION_INPUT_FILE = 'execution-input.json' as const;

export type ExecutionInputStoreErrorCode =
  | 'not_found'
  | 'not_prepared'
  | 'corrupt'
  | 'source_changed'
  | 'active_execution'
  | 'conflict'
  | 'invalid_input';

export class ExecutionInputStoreError extends Error {
  constructor(
    readonly code: ExecutionInputStoreErrorCode,
    message: string,
    readonly evidence?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ExecutionInputStoreError';
  }
}

interface LocatedTask {
  readonly task: SubAgentTask;
  readonly raw: string;
  readonly sourcePath: string;
  readonly sourceHash: string;
  readonly lifecycle: 'pending' | 'running';
}

export interface OwnedExecutionInputStore extends TaskExecutionInputStore {
  hasPreparedInput(taskId: FullTaskId): Promise<boolean>;
  readPreparedInput(taskId: FullTaskId): Promise<unknown>;
}

export interface ExecutionInputStoreOptions {
  /** Process-local evidence in addition to the conservative running/ rejection. */
  readonly hasActiveExecution?: (taskId: FullTaskId) => boolean;
}

const lifecycleDirs = [
  { lifecycle: 'pending', dir: TASKS_QUEUES_PENDING_DIR },
  { lifecycle: 'running', dir: TASKS_QUEUES_RUNNING_DIR },
] as const;

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'EEXIST';
}

function sidecarPath(taskId: FullTaskId): string {
  return `${TASKS_QUEUES_RESULTS_DIR}/${taskId}/${EXECUTION_INPUT_FILE}`;
}

function parseTask(raw: string, sourcePath: string, expectedId: FullTaskId): SubAgentTask {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ExecutionInputStoreError('corrupt', `task ${expectedId} is not valid JSON`, {
      sourcePath,
      error: String(error),
    });
  }
  const decoded = SubAgentTaskSchema.safeParse(parsed);
  if (!decoded.success || decoded.data.id !== expectedId) {
    throw new ExecutionInputStoreError('corrupt', `task ${expectedId} failed execution-input admission validation`, {
      sourcePath,
      error: decoded.success ? 'path_identity_mismatch' : decoded.error.message,
    });
  }
  // Return the original parsed object, not decoded.data: schema stripping must never
  // affect the source digest or discard fields an owner may need to migrate.
  return parsed as SubAgentTask;
}

function decodeSidecar(raw: string, task: LocatedTask): PreparedExecutionInputRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ExecutionInputStoreError('corrupt', `execution input for ${task.task.id} is not valid JSON`, {
      path: sidecarPath(task.task.id as FullTaskId),
      error: String(error),
    });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ExecutionInputStoreError('corrupt', `execution input for ${task.task.id} is not an object`);
  }
  const record = parsed as Record<string, unknown>;
  if (record.schema_version !== 1 || record.taskId !== task.task.id
    || typeof record.sourcePath !== 'string' || typeof record.sourceHash !== 'string'
    || typeof record.migrationSource !== 'string' || !Object.hasOwn(record, 'input')) {
    throw new ExecutionInputStoreError('corrupt', `execution input for ${task.task.id} has an invalid header`, {
      path: sidecarPath(task.task.id as FullTaskId),
    });
  }
  if (record.sourceHash !== task.sourceHash) {
    throw new ExecutionInputStoreError('source_changed', `execution input source hash changed for ${task.task.id}`, {
      expected: record.sourceHash,
      actual: task.sourceHash,
      sourcePath: task.sourcePath,
    });
  }
  return parsed as PreparedExecutionInputRecord;
}

async function readExistingSidecar(fs: FileSystem, task: LocatedTask): Promise<PreparedExecutionInputRecord | undefined> {
  let raw: string;
  try {
    raw = await fs.read(sidecarPath(task.task.id as FullTaskId));
  } catch (error) {
    if (isFileNotFound(error)) return undefined;
    throw error;
  }
  return decodeSidecar(raw, task);
}

async function locateTask(fs: FileSystem, taskId: FullTaskId): Promise<LocatedTask | undefined> {
  const found: LocatedTask[] = [];
  for (const { lifecycle, dir } of lifecycleDirs) {
    const sourcePath = `${dir}/${taskId}.json`;
    let raw: string;
    try {
      raw = await fs.read(sourcePath);
    } catch (error) {
      if (isFileNotFound(error)) continue;
      throw error;
    }
    const task = parseTask(raw, sourcePath, taskId);
    found.push({ task, raw, sourcePath, sourceHash: sha256Hex(raw), lifecycle });
  }
  if (found.length > 1) {
    throw new ExecutionInputStoreError('conflict', `task ${taskId} exists in multiple active lifecycle directories`, {
      paths: found.map(item => item.sourcePath),
    });
  }
  return found[0];
}

async function listActiveTasks(fs: FileSystem): Promise<LocatedTask[]> {
  const tasks: LocatedTask[] = [];
  const identities = new Set<FullTaskId>();
  for (const { lifecycle, dir } of lifecycleDirs) {
    let entries: Awaited<ReturnType<FileSystem['list']>>;
    try {
      entries = await fs.list(dir, { includeDirs: false });
    } catch (error) {
      if (isFileNotFound(error)) continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.name.endsWith('.json') || entry.name.includes('.corrupt-')) continue;
      const raw = await fs.read(entry.path);
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null || typeof (parsed as Record<string, unknown>).id !== 'string') {
        throw new ExecutionInputStoreError('corrupt', `active task has no readable identity: ${entry.path}`);
      }
      const taskId = adoptLegacyFullTaskId((parsed as Record<string, unknown>).id as string);
      if (identities.has(taskId)) {
        throw new ExecutionInputStoreError('conflict', `task ${taskId} has duplicate active records`, {
          paths: tasks.filter(item => item.task.id === taskId).map(item => item.sourcePath).concat(entry.path),
        });
      }
      const task = parseTask(raw, entry.path, taskId);
      identities.add(taskId);
      tasks.push({ task, raw, sourcePath: entry.path, sourceHash: sha256Hex(raw), lifecycle });
    }
  }
  return tasks;
}

export function createExecutionInputStore(
  fs: FileSystem,
  options: ExecutionInputStoreOptions = {},
): OwnedExecutionInputStore {
  async function requireTask(taskId: FullTaskId): Promise<LocatedTask> {
    const located = await locateTask(fs, taskId);
    if (!located) throw new ExecutionInputStoreError('not_found', `active task ${taskId} was not found`);
    return located;
  }

  return {
    async listUnpreparedInputs(): Promise<readonly UnpreparedExecutionInput[]> {
      const result: UnpreparedExecutionInput[] = [];
      for (const located of await listActiveTasks(fs)) {
        if (located.task.executionInput !== undefined) continue;
        if (await readExistingSidecar(fs, located) !== undefined) continue;
        const base = {
          taskId: located.task.id as FullTaskId,
          sourcePath: located.sourcePath,
          sourceHash: located.sourceHash,
          payload: located.task.executorPayload,
        };
        if (located.task.executorPayload !== undefined || located.task.summonDecision !== undefined) {
          result.push({ ...base, kind: 'needs_owner_migration' });
          continue;
        }
        result.push({
          ...base,
          kind: 'ordinary_legacy',
          declaration: {
            prompt: located.task.intent,
            ...(located.task.systemPrompt !== undefined ? { systemPrompt: located.task.systemPrompt } : {}),
            ...(located.task.toolProfile !== undefined ? { toolProfile: located.task.toolProfile } : {}),
            budget: {
              timeoutMs: located.task.timeoutMs,
              ...(located.task.maxSteps !== undefined ? { maxSteps: located.task.maxSteps } : {}),
            },
          },
        });
      }
      return result;
    },

    async commitPreparedInput(request: CommitPreparedExecutionInput): Promise<PreparedExecutionInputRecord> {
      const located = await requireTask(request.taskId);
      if (located.sourceHash !== request.sourceHash) {
        throw new ExecutionInputStoreError('source_changed', `execution input source hash changed for ${request.taskId}`, {
          expected: request.sourceHash,
          actual: located.sourceHash,
        });
      }
      if (located.lifecycle === 'running' || options.hasActiveExecution?.(request.taskId)) {
        throw new ExecutionInputStoreError('active_execution', `cannot prepare input while task ${request.taskId} is active`, {
          sourcePath: located.sourcePath,
        });
      }
      if (!isExecutionInputJsonValue(request.input)) {
        throw new ExecutionInputStoreError('invalid_input', `execution input for ${request.taskId} must be complete JSON`);
      }
      const record: PreparedExecutionInputRecord = {
        schema_version: 1,
        taskId: request.taskId,
        sourcePath: located.sourcePath,
        sourceHash: request.sourceHash,
        migrationSource: request.migrationSource,
        input: request.input,
      };
      const serialized = JSON.stringify(record, null, 2);
      const roundTrip = serialized === undefined ? undefined : JSON.parse(serialized) as Record<string, unknown>;
      if (roundTrip === undefined || !Object.hasOwn(roundTrip, 'input') || request.migrationSource.length === 0) {
        throw new ExecutionInputStoreError('invalid_input', `execution input for ${request.taskId} is not a complete JSON record`);
      }
      const existing = await readExistingSidecar(fs, located);
      if (existing !== undefined) {
        if (JSON.stringify(existing) === JSON.stringify(record)) return existing;
        throw new ExecutionInputStoreError('conflict', `execution input sidecar already exists for ${request.taskId}`, {
          existing,
          attempted: record,
        });
      }
      try {
        await fs.writeExclusive(sidecarPath(request.taskId), serialized);
        return record;
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        // A loser reads and preserves the complete winner. Different input/source is
        // an explicit conflict; no rename/writeAtomic fallback can overwrite it.
        const winner = await readExistingSidecar(fs, located);
        if (winner !== undefined && JSON.stringify(winner) === JSON.stringify(record)) return winner;
        throw new ExecutionInputStoreError('conflict', `execution input publish conflicted for ${request.taskId}`, {
          existing: winner,
          attempted: record,
          cause: String(error),
        });
      }
    },

    async hasPreparedInput(taskId: FullTaskId): Promise<boolean> {
      const located = await requireTask(taskId);
      if (located.task.executionInput !== undefined) return true;
      return await readExistingSidecar(fs, located) !== undefined;
    },

    async readPreparedInput(taskId: FullTaskId): Promise<unknown> {
      const located = await requireTask(taskId);
      if (located.task.executionInput !== undefined) return located.task.executionInput.input;
      const sidecar = await readExistingSidecar(fs, located);
      if (sidecar === undefined) {
        throw new ExecutionInputStoreError('not_prepared', `task ${taskId} has no bound prepared execution input`, {
          sourcePath: located.sourcePath,
          sourceHash: located.sourceHash,
        });
      }
      return sidecar.input;
    },
  };
}
