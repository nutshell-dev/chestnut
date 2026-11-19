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

export type DraftCheckpointOutcome = (
  | { kind: 'durable'; operation: 'persist' | 'clear' }
  | {
      kind: 'committed_platform_limited' | 'committed_durability_unknown' | 'failed' | 'revision_conflict';
      operation: 'persist' | 'clear';
      error: unknown;
    }
) & {
  /** Audit failure is additive: it must never overwrite the filesystem commit fact. */
  readonly auditError?: unknown;
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
  /** Synchronous submit/checkpoint handling time, including deduplication. */
  readonly latencyMs: number;
}

export type DraftFlushReason = 'submit' | 'dispose' | 'exit' | 'error';

export interface DraftFlushOutcome {
  readonly reason: DraftFlushReason;
  readonly latest?: DraftRevisionOutcome;
  readonly latencyMs: number;
  readonly auditError?: unknown;
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

function writeDraftAudit(audit: AuditLog, event: string, ...columns: string[]): unknown | undefined {
  try {
    audit.write(event, ...columns);
    return undefined;
  } catch (err) {
    // silent: the original audit error is returned as structured checkpoint evidence
    return err;
  }
}

function withAuditError<T extends DraftCheckpointOutcome>(outcome: T, auditError: unknown): T {
  if (auditError === undefined || outcome.auditError !== undefined) return outcome;
  return { ...outcome, auditError };
}

function observeRevisionOutcome(audit: AuditLog, outcome: DraftRevisionOutcome): DraftRevisionOutcome {
  const auditError = writeDraftAudit(
    audit,
    VIEWPORT_AUDIT_EVENTS.DRAFT_CHECKPOINT,
    `revision=${outcome.revision}`,
    `operation=${outcome.checkpoint.operation}`,
    `outcome=${outcome.checkpoint.kind}`,
    `deduplicated=${outcome.deduplicated}`,
    `latency_ms=${outcome.latencyMs}`,
  );
  return auditError === undefined
    ? outcome
    : { ...outcome, checkpoint: withAuditError(outcome.checkpoint, auditError) };
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
      const auditError = writeDraftAudit(
        audit,
        VIEWPORT_AUDIT_EVENTS.DRAFT_PERSIST_FAILED,
        ...columns,
        `chars=${text.length}`,
        `commit_state=${result.kind}`,
        `reason=${formatErr(result.error)}`,
      );
      return withAuditError(
        { kind: result.kind, operation: 'persist', error: result.error },
        auditError,
      );
    }
    const auditError = writeDraftAudit(
      audit,
      VIEWPORT_AUDIT_EVENTS.DRAFT_PERSISTED,
      ...columns,
      `chars=${text.length}`,
      `lines=${text.split('\n').length}`,
    );
    return withAuditError({ kind: 'durable', operation: 'persist' }, auditError);
  } catch (err) {
    const auditError = writeDraftAudit(
      audit,
      VIEWPORT_AUDIT_EVENTS.DRAFT_PERSIST_FAILED,
      ...columns,
      `chars=${text.length}`,
      'commit_state=failed',
      `reason=${formatErr(err)}`,
    );
    return withAuditError({ kind: 'failed', operation: 'persist', error: err }, auditError);
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
      const auditError = writeDraftAudit(
        audit,
        VIEWPORT_AUDIT_EVENTS.DRAFT_CLEAR_FAILED,
        ...columns,
        `reason=${reason}`,
        'commit_state=failed',
        `error=${formatErr(err)}`,
      );
      return withAuditError({ kind: 'failed', operation: 'clear', error: err }, auditError);
    }
  }
  try {
    fs.syncSync('.');
  } catch (err) {
    const result = classifyDirFsyncError(err);
    const kind = result.kind === 'durable' ? 'committed_durability_unknown' : result.kind;
    const error = result.kind === 'durable' ? err : result.error;
    const auditError = writeDraftAudit(
      audit,
      VIEWPORT_AUDIT_EVENTS.DRAFT_CLEAR_FAILED,
      ...columns,
      `reason=${reason}`,
      `commit_state=${kind}`,
      `error=${formatErr(error)}`,
    );
    return withAuditError({ kind, operation: 'clear', error }, auditError);
  }
  const auditError = writeDraftAudit(
    audit,
    VIEWPORT_AUDIT_EVENTS.DRAFT_CLEARED,
    ...columns,
    `reason=${reason}`,
    `already_absent=${alreadyAbsent}`,
  );
  return withAuditError({ kind: 'durable', operation: 'clear' }, auditError);
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
 * Only a clean durable identical repeat can be deduplicated; failed/limited/audit-degraded
 * checkpoints are retried under the same revision so recovery never requires fake text changes.
 */
export function createDraftPersistenceScheduler(
  fs: FileSystem,
  audit: AuditLog,
): DraftPersistenceScheduler {
  let latest: { input: DraftRevision; outcome: DraftRevisionOutcome } | null = null;
  return {
    submit(input) {
      const startedAtMs = Date.now();
      if (latest?.input.revision === input.revision) {
        if (latest.input.text !== input.text || latest.input.changedAtMs !== input.changedAtMs) {
          const error = new Error(`draft revision conflict: ${input.revision}`);
          const auditError = writeDraftAudit(
            audit,
            VIEWPORT_AUDIT_EVENTS.DRAFT_PERSIST_FAILED,
            `revision=${input.revision}`,
            `changed_at_ms=${input.changedAtMs}`,
            'commit_state=revision_conflict',
            `reason=${formatErr(error)}`,
          );
          const outcome: DraftRevisionOutcome = {
            revision: input.revision,
            checkpoint: withAuditError(
              { kind: 'revision_conflict', operation: 'persist', error },
              auditError,
            ),
            deduplicated: false,
            latencyMs: Date.now() - startedAtMs,
          };
          return observeRevisionOutcome(audit, outcome);
        }
        if (
          latest.outcome.checkpoint.kind === 'durable'
          && latest.outcome.checkpoint.auditError === undefined
        ) {
          const outcome: DraftRevisionOutcome = {
            ...latest.outcome,
            deduplicated: true,
            latencyMs: Date.now() - startedAtMs,
          };
          const auditError = writeDraftAudit(
            audit,
            VIEWPORT_AUDIT_EVENTS.DRAFT_REVISION_DEDUPLICATED,
            `revision=${input.revision}`,
            `checkpoint=${latest.outcome.checkpoint.kind}`,
            `latency_ms=${outcome.latencyMs}`,
          );
          return auditError === undefined
            ? outcome
            : { ...outcome, checkpoint: withAuditError(outcome.checkpoint, auditError) };
        }
      }
      const checkpoint = persistDraftCheckpoint(fs, audit, input.text, input);
      const outcome = observeRevisionOutcome(audit, {
        revision: input.revision,
        checkpoint,
        deduplicated: false,
        latencyMs: Date.now() - startedAtMs,
      });
      latest = { input, outcome };
      return outcome;
    },
    flush(reason) {
      const startedAtMs = Date.now();
      const latencyMs = Date.now() - startedAtMs;
      const auditError = writeDraftAudit(
        audit,
        VIEWPORT_AUDIT_EVENTS.DRAFT_FLUSH,
        `reason=${reason}`,
        `latest_revision=${latest?.input.revision ?? 'none'}`,
        `checkpoint=${latest?.outcome.checkpoint.kind ?? 'none'}`,
        `latency_ms=${latencyMs}`,
      );
      return {
        reason,
        latest: latest?.outcome,
        latencyMs,
        ...(auditError === undefined ? {} : { auditError }),
      };
    },
  };
}

/** Allocate revisions by text state, not by callback count. */
export function createDraftEditorChangeHandler(
  scheduler: DraftPersistenceScheduler,
  initialText: string,
  onOutcome: (outcome: DraftRevisionOutcome) => void,
  now: () => number = Date.now,
): (text: string) => void {
  let revision = 0;
  let currentText = initialText;
  let changedAtMs = 0;
  return (text) => {
    if (text !== currentText) {
      revision += 1;
      currentText = text;
      changedAtMs = now();
    }
    onOutcome(scheduler.submit({ revision, text, changedAtMs }));
  };
}

interface DraftCheckpointReporterDeps {
  readonly audit: AuditLog;
  readonly appendOutput: (color: string, text: string, wrap?: boolean) => void;
  readonly requestRender: () => void;
}

/** Make every non-durable or audit-degraded result visible and report later recovery. */
export function createDraftCheckpointReporter(
  deps: DraftCheckpointReporterDeps,
): (outcome: DraftRevisionOutcome) => void {
  let visibleIssue: { revision: number; state: string } | null = null;
  return (outcome) => {
    const { checkpoint } = outcome;
    const state = checkpoint.kind !== 'durable'
      ? checkpoint.kind
      : checkpoint.auditError !== undefined ? 'audit_failed' : 'clean';
    if (state === 'clean') {
      if (!visibleIssue) return;
      writeDraftAudit(
        deps.audit,
        VIEWPORT_AUDIT_EVENTS.DRAFT_RECOVERED,
        `revision=${outcome.revision}`,
        `previous_revision=${visibleIssue.revision}`,
        `previous_state=${visibleIssue.state}`,
        'checkpoint=durable',
      );
      deps.appendOutput(
        '\x1b[32m',
        `[draft checkpoint recovered: revision=${outcome.revision}]`,
        true,
      );
      visibleIssue = null;
      deps.requestRender();
      return;
    }
    if (visibleIssue?.revision === outcome.revision && visibleIssue.state === state) return;
    const error = checkpoint.kind === 'durable' ? checkpoint.auditError : checkpoint.error;
    writeDraftAudit(
      deps.audit,
      VIEWPORT_AUDIT_EVENTS.DRAFT_FAILURE_VISIBLE,
      `revision=${outcome.revision}`,
      `checkpoint=${checkpoint.kind}`,
      `state=${state}`,
      `latency_ms=${outcome.latencyMs}`,
      `reason=${formatErr(error)}`,
    );
    deps.appendOutput(
      checkpoint.kind === 'durable' ? '\x1b[33m' : '\x1b[31m',
      `[draft checkpoint ${state}: ${formatErr(error)}; editor text retained; retry or edit to recover]`,
      true,
    );
    visibleIssue = { revision: outcome.revision, state };
    deps.requestRender();
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
