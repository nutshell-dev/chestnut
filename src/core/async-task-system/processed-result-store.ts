/**
 * @module L4.AsyncTaskSystem.ProcessedResultStore
 * Phase 1396 Step L: single-file authoritative store for processed task outcomes.
 *
 * `result-envelope.json` (one atomic write) is the ONLY authority for the final
 * outcome: delivery content, `is_error`, and done/failed terminal classification.
 * `result.txt` remains a rebuildable, non-authoritative CLI/human projection.
 *
 * This module owns the only disk codec: in-memory `ProcessedTaskResult` is
 * camelCase (`isError`); disk JSON is snake_case (`is_error`) via the strict
 * Zod schema below. No other module may parse/serialize the envelope JSON.
 *
 * Read semantics: only `absent` returns undefined. I/O failure, schema
 * corruption, and future schema versions all throw typed errors — callers
 * (recovery) audit and keep the task in running; never default to success.
 */

import { z } from 'zod';
import type { FileSystem } from '../../foundation/fs/index.js';
import { isFileNotFound } from '../../foundation/fs/index.js';
import { TASKS_QUEUES_RESULTS_DIR, RESULT_META_FILE, RESULT_ENVELOPE_FILE } from './dirs.js';
import { formatErr } from './_helpers.js';
import type { ProcessedTaskResult } from './result-delivery-types.js';
import type { SubAgentTask, TaskId } from './types.js';

/** Authoritative disk schema (snake_case). Strict: unknown keys are corruption. */
export const ProcessedTaskResultSchema = z.object({
  schema_version: z.literal(1),
  content: z.string(),
  is_error: z.boolean(),
  metadata: z.record(z.string()).optional(),
}).strict();

/** Step J legacy intermediate meta (result-meta.json) — read-only, recovery migration only. */
const LegacyResultMetaSchema = z.object({
  schema_version: z.literal(1),
  is_error: z.boolean(),
  metadata: z.record(z.string()).optional(),
}).strict();

/** Envelope file exists but cannot be read (I/O failure). */
export class ProcessedResultReadError extends Error {
  constructor(taskId: string, cause: unknown) {
    super(`processed result envelope unreadable for task ${taskId}: ${formatErr(cause)}`);
    this.name = 'ProcessedResultReadError';
  }
}

/** Envelope file exists but is not valid JSON or violates the strict schema. */
export class ProcessedResultCorruptError extends Error {
  constructor(taskId: string, detail: string) {
    super(`processed result envelope corrupt for task ${taskId}: ${detail}`);
    this.name = 'ProcessedResultCorruptError';
  }
}

/** Envelope was written by a newer schema version — never guess its meaning. */
export class ProcessedResultUnsupportedVersionError extends Error {
  constructor(taskId: string, version: unknown) {
    super(`processed result envelope for task ${taskId} has unsupported schema_version=${String(version)}`);
    this.name = 'ProcessedResultUnsupportedVersionError';
  }
}

/** In-memory → disk codec (snake_case). The only envelope serializer. */
export function envelopeToDiskJson(result: ProcessedTaskResult): string {
  return JSON.stringify({
    schema_version: 1,
    content: result.content,
    is_error: result.isError,
    ...(result.metadata !== undefined ? { metadata: result.metadata } : {}),
  });
}

function parseEnvelope(raw: string, taskId: TaskId): ProcessedTaskResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ProcessedResultCorruptError(taskId, `invalid JSON: ${formatErr(err)}`);
  }
  if (typeof parsed === 'object' && parsed !== null) {
    const version = (parsed as { schema_version?: unknown }).schema_version;
    if (typeof version === 'number' && version !== 1) {
      throw new ProcessedResultUnsupportedVersionError(taskId, version);
    }
  }
  const result = ProcessedTaskResultSchema.safeParse(parsed);
  if (!result.success) {
    throw new ProcessedResultCorruptError(taskId, result.error.issues.map(i => i.message).join('; '));
  }
  return {
    schema_version: 1,
    content: result.data.content,
    isError: result.data.is_error,
    ...(result.data.metadata !== undefined ? { metadata: result.data.metadata } : {}),
  };
}

export interface ProcessedResultStore {
  /** Single atomic commit of the final envelope — the only business commit point. */
  commit(taskId: TaskId, result: ProcessedTaskResult): Promise<void>;
  /** absent → undefined; I/O failure / corruption / future version → typed error. */
  read(taskId: TaskId): Promise<ProcessedTaskResult | undefined>;
  /** Rebuildable non-authoritative projection; failure must never rewrite the envelope. */
  projectText(taskId: TaskId, result: ProcessedTaskResult): Promise<void>;
  /**
   * Step J compatibility: combine a strictly-validated `result-meta.json` +
   * `result.txt` pair into a committed envelope. Corrupt/unknown/half-written
   * intermediates are 'indeterminate' — never defaulted to success.
   */
  migrateIntermediate(task: SubAgentTask): Promise<'migrated' | 'absent' | 'indeterminate'>;
}

export function createProcessedResultStore(fs: FileSystem): ProcessedResultStore {
  const resultDir = (taskId: TaskId): string => `${TASKS_QUEUES_RESULTS_DIR}/${taskId}`;
  const envelopePath = (taskId: TaskId): string => `${resultDir(taskId)}/${RESULT_ENVELOPE_FILE}`;

  async function commit(taskId: TaskId, result: ProcessedTaskResult): Promise<void> {
    await fs.ensureDir(resultDir(taskId));
    await fs.writeAtomic(envelopePath(taskId), envelopeToDiskJson(result));
  }

  return {
    commit,

    async read(taskId: TaskId): Promise<ProcessedTaskResult | undefined> {
      let raw: string;
      try {
        raw = await fs.read(envelopePath(taskId));
      } catch (err) {
        if (isFileNotFound(err)) return undefined;
        throw new ProcessedResultReadError(taskId, err);
      }
      return parseEnvelope(raw, taskId);
    },

    async projectText(taskId: TaskId, result: ProcessedTaskResult): Promise<void> {
      await fs.writeAtomic(`${resultDir(taskId)}/result.txt`, result.content);
    },

    async migrateIntermediate(task: SubAgentTask): Promise<'migrated' | 'absent' | 'indeterminate'> {
      const dir = resultDir(task.id);
      let metaRaw: string;
      try {
        metaRaw = await fs.read(`${dir}/${RESULT_META_FILE}`);
      } catch (err) {
        // silent: absent meta is the normal non-Step-J case; unreadable meta is
        // surfaced to the caller as 'indeterminate', which recovery audits.
        if (isFileNotFound(err)) return 'absent'; // no Step J intermediate (bare legacy result.txt is not ours)
        return 'indeterminate';
      }
      let metaParsed: unknown;
      try {
        metaParsed = JSON.parse(metaRaw);
      } catch {
        // silent: unparseable meta is surfaced as 'indeterminate'; recovery audits it.
        return 'indeterminate';
      }
      if (typeof metaParsed === 'object' && metaParsed !== null) {
        const version = (metaParsed as { schema_version?: unknown }).schema_version;
        if (typeof version === 'number' && version !== 1) return 'indeterminate';
      }
      const meta = LegacyResultMetaSchema.safeParse(metaParsed);
      if (!meta.success) return 'indeterminate';
      let content: string;
      try {
        content = await fs.read(`${dir}/result.txt`);
      } catch {
        // silent: meta without text means content is unknowable — surfaced as
        // 'indeterminate' (never guessed); recovery audits it.
        return 'indeterminate';
      }
      await commit(task.id, {
        schema_version: 1,
        content,
        isError: meta.data.is_error,
        ...(meta.data.metadata !== undefined ? { metadata: meta.data.metadata } : {}),
      });
      return 'migrated';
    },
  };
}
