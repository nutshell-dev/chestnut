/**
 * @module L4.ContractSystem.ArchiveReader
 * Phase 1145 Step B: typed dual-format archive payload reader.
 *
 * Pure read-only boundary for located archive entries. Every entry either returns
 * a verified `ArchivePayloadView` or a typed `ArchiveReadIssue`. No filesystem
 * mutation, no archive-time provenance, no lifecycle side effects.
 */

import * as yaml from 'js-yaml';
import { isFileNotFound, type FileSystem } from '../../foundation/fs/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { formatErr } from '../../foundation/node-utils/index.js';
import { CONTRACT_AUDIT_EVENTS } from './audit-events.js';
import {
  PersistedContractYamlSchema,
  ContractProgressArchiveLooseSchema,
} from './schemas.js';
import {
  getContractYamlPath,
  getContractSubtasksDir,
  readStrictContractLayoutAtRoot,
  projectCurrentRuntime,
} from './new-layout.js';
import { ContractLayoutCorruptedError } from './errors.js';
import { contractProgressPath } from './locations.js';
import {
  deriveProgressStatus,
  type ContractId,
  type ArchiveState,
  type ArchivePayloadView,
  type ArchiveReadIssue,
  type ArchiveReadIssueCode,
  type ProgressData,
  type SubtaskStatus,
} from './types.js';

export type { ArchivePayloadView, ArchiveReadIssue, ArchiveReadIssueCode };

export type ArchivePayloadReadResult =
  | { kind: 'found'; view: ArchivePayloadView }
  | { kind: 'issue'; issue: ArchiveReadIssue };

interface ArchivePayloadLocation {
  kind: 'archived-current' | 'archived-legacy';
  state?: ArchiveState;
  containerDir: string;
  contractRoot: string;
}

interface ReadArchivePayloadOpts {
  fs: FileSystem;
  audit: AuditLog;
  location: ArchivePayloadLocation;
  contractId: ContractId;
}

function emitArchiveReadIssue(audit: AuditLog, issue: ArchiveReadIssue): void {
  audit.write(
    CONTRACT_AUDIT_EVENTS.ARCHIVE_PAYLOAD_READ_ISSUE,
    `code=${issue.code}`,
    `contractId=${issue.contractId}`,
    `root=${issue.root}`,
    issue.detail ? `detail=${typeof audit.preview === 'function' ? audit.preview(issue.detail) : issue.detail}` : '',
  );
}

function makeIssue(
  code: ArchiveReadIssueCode,
  contractId: ContractId,
  root: string,
  detail?: string,
  cause?: unknown,
): ArchiveReadIssue {
  return { code, contractId, root, detail, cause };
}

function mapLegacySubtaskStatus(status: string | undefined): SubtaskStatus | null {
  switch (status) {
    case 'pending':
      return 'todo';
    case 'running':
      return 'in_progress';
    case 'completed':
      return 'completed';
    case undefined:
      return 'todo';
    default:
      return null;
  }
}

function mapLegacyCause(
  cause: string | undefined,
): NonNullable<ProgressData['subtasks'][string]['last_failed_feedback']>['cause'] | undefined {
  if (
    cause === 'llm_rejected' ||
    cause === 'programming_bug' ||
    cause === 'subagent_timeout' ||
    cause === 'script_failed'
  ) {
    return cause;
  }
  return undefined;
}

function projectLegacyProgress(
  contractId: ContractId,
  root: string,
  raw: Record<string, unknown>,
): { progress: ProgressData } | { issue: ArchiveReadIssue } {
  const parse = ContractProgressArchiveLooseSchema.safeParse(raw);
  if (!parse.success) {
    return {
      issue: makeIssue(
        'progress_schema_invalid',
        contractId,
        root,
        parse.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '),
      ),
    };
  }
  const loose = parse.data;
  const subtasks: ProgressData['subtasks'] = {};
  for (const [subtaskId, st] of Object.entries(loose.subtasks)) {
    const status = mapLegacySubtaskStatus(st.status);
    if (status === null) {
      return {
        issue: makeIssue(
          'progress_projection_failed',
          contractId,
          root,
          `subtask=${subtaskId} status=${st.status ?? 'undefined'}`,
        ),
      };
    }
    const lff = st.last_failed_feedback;
    subtasks[subtaskId] = {
      status,
      completed_at: st.completed_at,
      evidence: st.evidence,
      artifacts: st.artifacts,
      retry_count: st.retry_count,
      last_failed_feedback: lff
        ? {
            feedback: lff.feedback ?? '',
            cause: mapLegacyCause(lff.cause) ?? 'llm_rejected',
          }
        : undefined,
      force_accepted: st.force_accepted,
    };
  }
  const progress: ProgressData = {
    schema_version: 1,
    contract_id: contractId,
    status: deriveProgressStatus({ subtasks }),
    subtasks,
    started_at: loose.started_at,
    completed_at: loose.completed_at,
    checkpoint: loose.checkpoint === null ? undefined : loose.checkpoint,
  };
  return { progress };
}

async function readLegacyArchivePayload(
  deps: { fs: FileSystem; audit: AuditLog },
  contractId: ContractId,
  root: string,
): Promise<ArchivePayloadReadResult> {
  const yamlPath = getContractYamlPath(root);
  let content: string;
  try {
    content = await deps.fs.read(yamlPath);
  } catch (err) {
    if (isFileNotFound(err)) {
      return { kind: 'issue', issue: makeIssue('yaml_missing', contractId, root, `path=${yamlPath}`) };
    }
    return { kind: 'issue', issue: makeIssue('io_error', contractId, root, `path=${yamlPath}`, err) };
  }

  let raw: unknown;
  try {
    raw = yaml.load(content);
  } catch (yamlErr) {
    return { kind: 'issue', issue: makeIssue('yaml_parse_error', contractId, root, formatErr(yamlErr), yamlErr) };
  }

  const parsed = PersistedContractYamlSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      kind: 'issue',
      issue: makeIssue(
        'yaml_schema_invalid',
        contractId,
        root,
        parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '),
      ),
    };
  }

  if (parsed.data.id !== contractId) {
    return {
      kind: 'issue',
      issue: makeIssue('yaml_id_mismatch', contractId, root, `expected=${contractId} actual=${parsed.data.id}`),
    };
  }

  const progressPath = contractProgressPath(root);
  let progressRaw: string;
  try {
    progressRaw = await deps.fs.read(progressPath);
  } catch (err) {
    if (isFileNotFound(err)) {
      return {
        kind: 'issue',
        issue: makeIssue('entry_disappeared', contractId, root, 'progress.json missing after layout detection'),
      };
    }
    return { kind: 'issue', issue: makeIssue('io_error', contractId, root, `path=${progressPath}`, err) };
  }

  let progressParsed: unknown;
  try {
    progressParsed = JSON.parse(progressRaw);
  } catch (parseErr) {
    return {
      kind: 'issue',
      issue: makeIssue('progress_parse_error', contractId, root, formatErr(parseErr), parseErr),
    };
  }

  const projected = projectLegacyProgress(contractId, root, progressParsed as Record<string, unknown>);
  if ('issue' in projected) {
    return { kind: 'issue', issue: projected.issue };
  }

  const view: ArchivePayloadView = {
    contractId,
    state: 'legacy-unresolved',
    root,
    layout: 'legacy',
    contract: parsed.data,
    progress: projected.progress,
  };
  return { kind: 'found', view };
}

async function readCurrentArchivePayload(
  deps: { fs: FileSystem; audit: AuditLog },
  contractId: ContractId,
  root: string,
  state: ArchiveState,
): Promise<ArchivePayloadReadResult> {
  try {
    const layout = await readStrictContractLayoutAtRoot(deps, root, contractId);
    const runtime = projectCurrentRuntime(layout);
    const view: ArchivePayloadView = {
      contractId,
      state,
      root,
      layout: 'current',
      contract: layout.contract,
      progress: runtime.progress,
    };
    return { kind: 'found', view };
  } catch (err) {
    if (err instanceof ContractLayoutCorruptedError) {
      // Strict reader already emitted LAYOUT_CORRUPTED; map to issue without duplicate audit.
      return {
        kind: 'issue',
        issue: makeIssue('layout_corrupted', contractId, root, err.message),
      };
    }
    return { kind: 'issue', issue: makeIssue('io_error', contractId, root, formatErr(err), err) };
  }
}

/**
 * Read a located archive entry and return either a verified payload view or a
 * typed issue. The reader performs no mutation and does not read archive-time
 * provenance.
 */
export async function readArchivePayload(
  opts: ReadArchivePayloadOpts,
): Promise<ArchivePayloadReadResult> {
  const { fs, audit, location, contractId } = opts;
  const root = location.contractRoot;
  const subtasksDir = getContractSubtasksDir(root);
  const progressPath = contractProgressPath(root);

  let hasSubtasks: boolean;
  let hasProgress: boolean;
  try {
    [hasSubtasks, hasProgress] = await Promise.all([
      fs.exists(subtasksDir),
      fs.exists(progressPath),
    ]);
  } catch (err) {
    return { kind: 'issue', issue: makeIssue('io_error', contractId, root, formatErr(err), err) };
  }

  if (hasSubtasks && hasProgress) {
    const issue = makeIssue('ambiguous_layout', contractId, root, 'both subtasks/ and progress.json present');
    emitArchiveReadIssue(audit, issue);
    return { kind: 'issue', issue };
  }
  if (!hasSubtasks && !hasProgress) {
    const issue = makeIssue('missing_payload', contractId, root, 'neither subtasks/ nor progress.json present');
    emitArchiveReadIssue(audit, issue);
    return { kind: 'issue', issue };
  }

  const result = hasSubtasks
    ? await readCurrentArchivePayload({ fs, audit }, contractId, root, location.state as ArchiveState)
    : await readLegacyArchivePayload({ fs, audit }, contractId, root);

  if (result.kind === 'issue' && result.issue.code !== 'layout_corrupted') {
    // layout_corrupted was already audited by the strict current reader.
    emitArchiveReadIssue(audit, result.issue);
  }
  return result;
}
