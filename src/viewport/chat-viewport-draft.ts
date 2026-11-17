import type { AuditLog } from '../foundation/audit/index.js';
import type { FileSystem } from '../foundation/fs/index.js';
import { classifyDirFsyncError, isFileNotFound } from '../foundation/fs/index.js';
import { formatErr } from '../foundation/node-utils/index.js';
import { VIEWPORT_AUDIT_EVENTS } from './viewport-audit-events.js';

export const VIEWPORT_DRAFT_FILE = 'viewport-draft.json';
const VIEWPORT_DRAFT_SCHEMA_VERSION = 1;

interface ViewportDraftDocument {
  version: typeof VIEWPORT_DRAFT_SCHEMA_VERSION;
  text: string;
  updatedAt: string;
}

type ViewportDraftLoadResult =
  | { kind: 'none' }
  | { kind: 'restored'; text: string }
  | { kind: 'quarantined'; path: string };

function encodeDraft(text: string): string {
  const document: ViewportDraftDocument = {
    version: VIEWPORT_DRAFT_SCHEMA_VERSION,
    text,
    updatedAt: new Date().toISOString(),
  };
  return `${JSON.stringify(document)}\n`;
}

function decodeDraft(raw: string): ViewportDraftDocument {
  const parsed = JSON.parse(raw) as Partial<ViewportDraftDocument>;
  if (
    parsed.version !== VIEWPORT_DRAFT_SCHEMA_VERSION
    || typeof parsed.text !== 'string'
    || typeof parsed.updatedAt !== 'string'
    || !Number.isFinite(Date.parse(parsed.updatedAt))
  ) {
    throw new Error('invalid viewport draft schema');
  }
  return parsed as ViewportDraftDocument;
}

/**
 * Load the mutable current-draft resource. A malformed artifact is moved aside
 * before editing can continue; if quarantine itself fails, startup fails rather
 * than silently overwriting the only recoverable user input.
 */
export function loadViewportDraft(fs: FileSystem, audit: AuditLog): ViewportDraftLoadResult {
  let raw: string;
  try {
    raw = fs.readSync(VIEWPORT_DRAFT_FILE);
  } catch (err) {
    if (isFileNotFound(err)) return { kind: 'none' };
    audit.write(VIEWPORT_AUDIT_EVENTS.DRAFT_RESTORE_FAILED, `reason=${formatErr(err)}`);
    throw err;
  }

  try {
    const draft = decodeDraft(raw);
    audit.write(
      VIEWPORT_AUDIT_EVENTS.DRAFT_RESTORED,
      `chars=${draft.text.length}`,
      `lines=${draft.text.split('\n').length}`,
    );
    return { kind: 'restored', text: draft.text };
  } catch (err) {
    const quarantinePath = `viewport-draft.corrupt.${Date.now()}.json`;
    try {
      fs.moveSync(VIEWPORT_DRAFT_FILE, quarantinePath);
    } catch (moveErr) {
      audit.write(
        VIEWPORT_AUDIT_EVENTS.DRAFT_RESTORE_FAILED,
        `reason=${formatErr(err)}`,
        `quarantine_reason=${formatErr(moveErr)}`,
      );
      throw moveErr;
    }
    audit.write(
      VIEWPORT_AUDIT_EVENTS.DRAFT_QUARANTINED,
      `reason=${formatErr(err)}`,
      `path=${quarantinePath}`,
    );
    return { kind: 'quarantined', path: quarantinePath };
  }
}

export type DraftCheckpointOutcome =
  | { kind: 'durable'; operation: 'persist' | 'clear' }
  | {
      kind: 'committed_platform_limited' | 'committed_durability_unknown' | 'failed' | 'revision_conflict';
      operation: 'persist' | 'clear';
      error: unknown;
    };

export interface DraftRevision {
  readonly revision: number;
  readonly text: string;
  readonly changedAtMs: number;
}

export interface DraftRevisionOutcome {
  readonly revision: number;
  readonly checkpoint: DraftCheckpointOutcome;
  readonly deduplicated: boolean;
}

export type DraftFlushReason = 'submit' | 'dispose' | 'exit' | 'error';

export interface DraftFlushOutcome {
  readonly reason: DraftFlushReason;
  readonly latest?: DraftRevisionOutcome;
}

export interface DraftPersistenceScheduler {
  submit(revision: DraftRevision): DraftRevisionOutcome;
  flush(reason: DraftFlushReason): DraftFlushOutcome;
}

function checkpointColumns(revision?: DraftRevision): string[] {
  return revision
    ? [`revision=${revision.revision}`, `changed_at_ms=${revision.changedAtMs}`]
    : [];
}

function persistDraftCheckpoint(
  fs: FileSystem,
  audit: AuditLog,
  text: string,
  revision?: DraftRevision,
): DraftCheckpointOutcome {
  if (text.length === 0) {
    return clearDraftCheckpoint(fs, audit, 'explicit_empty_state', revision);
  }
  const columns = checkpointColumns(revision);
  try {
    const result = fs.writeAtomicSync(VIEWPORT_DRAFT_FILE, encodeDraft(text));
    if (result.kind !== 'durable') {
      audit.write(
        VIEWPORT_AUDIT_EVENTS.DRAFT_PERSIST_FAILED,
        ...columns,
        `chars=${text.length}`,
        `commit_state=${result.kind}`,
        `reason=${formatErr(result.error)}`,
      );
      return { kind: result.kind, operation: 'persist', error: result.error };
    }
    audit.write(
      VIEWPORT_AUDIT_EVENTS.DRAFT_PERSISTED,
      ...columns,
      `chars=${text.length}`,
      `lines=${text.split('\n').length}`,
    );
    return { kind: 'durable', operation: 'persist' };
  } catch (err) {
    audit.write(
      VIEWPORT_AUDIT_EVENTS.DRAFT_PERSIST_FAILED,
      ...columns,
      `chars=${text.length}`,
      'commit_state=failed',
      `reason=${formatErr(err)}`,
    );
    return { kind: 'failed', operation: 'persist', error: err };
  }
}

function clearDraftCheckpoint(
  fs: FileSystem,
  audit: AuditLog,
  reason: string,
  revision?: DraftRevision,
): DraftCheckpointOutcome {
  const columns = checkpointColumns(revision);
  let alreadyAbsent = false;
  try {
    fs.deleteSync(VIEWPORT_DRAFT_FILE);
  } catch (err) {
    if (isFileNotFound(err)) alreadyAbsent = true;
    else {
      audit.write(
        VIEWPORT_AUDIT_EVENTS.DRAFT_CLEAR_FAILED,
        ...columns,
        `reason=${reason}`,
        'commit_state=failed',
        `error=${formatErr(err)}`,
      );
      return { kind: 'failed', operation: 'clear', error: err };
    }
  }
  try {
    fs.syncSync('.');
  } catch (err) {
    const result = classifyDirFsyncError(err);
    const kind = result.kind === 'durable' ? 'committed_durability_unknown' : result.kind;
    audit.write(
      VIEWPORT_AUDIT_EVENTS.DRAFT_CLEAR_FAILED,
      ...columns,
      `reason=${reason}`,
      `commit_state=${kind}`,
      `error=${formatErr(result.kind === 'durable' ? err : result.error)}`,
    );
    return { kind, operation: 'clear', error: result.kind === 'durable' ? err : result.error };
  }
  audit.write(
    VIEWPORT_AUDIT_EVENTS.DRAFT_CLEARED,
    ...columns,
    `reason=${reason}`,
    `already_absent=${alreadyAbsent}`,
  );
  return { kind: 'durable', operation: 'clear' };
}

/** Persist one draft revision synchronously and return its durable checkpoint outcome. */
export function persistViewportDraft(
  fs: FileSystem,
  audit: AuditLog,
  text: string,
): DraftCheckpointOutcome {
  return persistDraftCheckpoint(fs, audit, text);
}

/**
 * Strict draft scheduler: every distinct revision reaches a synchronous checkpoint.
 * Only an identical repeat of the same revision can be deduplicated.
 */
export function createDraftPersistenceScheduler(
  fs: FileSystem,
  audit: AuditLog,
): DraftPersistenceScheduler {
  let latest: { input: DraftRevision; outcome: DraftRevisionOutcome } | null = null;
  return {
    submit(input) {
      if (latest?.input.revision === input.revision) {
        if (latest.input.text !== input.text || latest.input.changedAtMs !== input.changedAtMs) {
          const error = new Error(`draft revision conflict: ${input.revision}`);
          audit.write(
            VIEWPORT_AUDIT_EVENTS.DRAFT_PERSIST_FAILED,
            `revision=${input.revision}`,
            `changed_at_ms=${input.changedAtMs}`,
            'commit_state=revision_conflict',
            `reason=${formatErr(error)}`,
          );
          return {
            revision: input.revision,
            checkpoint: { kind: 'revision_conflict', operation: 'persist', error },
            deduplicated: false,
          };
        }
        audit.write(
          VIEWPORT_AUDIT_EVENTS.DRAFT_REVISION_DEDUPLICATED,
          `revision=${input.revision}`,
          `checkpoint=${latest.outcome.checkpoint.kind}`,
        );
        return { ...latest.outcome, deduplicated: true };
      }
      const checkpoint = persistDraftCheckpoint(fs, audit, input.text, input);
      const outcome = { revision: input.revision, checkpoint, deduplicated: false };
      latest = { input, outcome };
      return outcome;
    },
    flush(reason) {
      const outcome = { reason, latest: latest?.outcome };
      audit.write(
        VIEWPORT_AUDIT_EVENTS.DRAFT_FLUSH,
        `reason=${reason}`,
        `latest_revision=${latest?.input.revision ?? 'none'}`,
        `checkpoint=${latest?.outcome.checkpoint.kind ?? 'none'}`,
      );
      return outcome;
    },
  };
}

/**
 * Clear the mutable draft.
 *
 * phase 1874 Step C（cli-viewport-draft-cleared-before-commit）：reason 显式化——
 * 空编辑器（`explicit_empty_state`）与提交成功（`submitted`，inbox 已持权威副本）可辨。
 */
export function clearViewportDraft(fs: FileSystem, audit: AuditLog, reason: string): void {
  clearDraftCheckpoint(fs, audit, reason);
}
