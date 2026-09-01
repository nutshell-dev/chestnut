import type { AuditLog } from '../../foundation/audit/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import { isFileNotFound } from '../../foundation/fs/index.js';
import { formatErr } from '../../foundation/node-utils/index.js';
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

/** Persist the latest draft atomically. Superseded revisions are mutable UI state by design. */
export function persistViewportDraft(fs: FileSystem, audit: AuditLog, text: string): void {
  if (text.length === 0) {
    clearViewportDraft(fs, audit);
    return;
  }
  try {
    fs.writeAtomicSync(VIEWPORT_DRAFT_FILE, encodeDraft(text));
    audit.write(
      VIEWPORT_AUDIT_EVENTS.DRAFT_PERSISTED,
      `chars=${text.length}`,
      `lines=${text.split('\n').length}`,
    );
  } catch (err) {
    audit.write(
      VIEWPORT_AUDIT_EVENTS.DRAFT_PERSIST_FAILED,
      `chars=${text.length}`,
      `reason=${formatErr(err)}`,
    );
  }
}

/** Empty text is an explicit clear decision; submitted content has moved to the inbox owner. */
export function clearViewportDraft(fs: FileSystem, audit: AuditLog): void {
  try {
    fs.deleteSync(VIEWPORT_DRAFT_FILE);
    audit.write(VIEWPORT_AUDIT_EVENTS.DRAFT_CLEARED, 'reason=explicit_empty_state');
  } catch (err) {
    if (isFileNotFound(err)) return;
    audit.write(VIEWPORT_AUDIT_EVENTS.DRAFT_CLEAR_FAILED, `reason=${formatErr(err)}`);
  }
}
