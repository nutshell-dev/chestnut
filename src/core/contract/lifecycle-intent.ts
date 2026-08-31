/**
 * @module L4.ContractSystem.LifecycleIntent
 * Phase 1198 Step A: immutable contract lifecycle intent store.
 *
 * Stable request facts for terminal lifecycle transitions. Stored outside
 * active/archive so both winner and loser requests can be persisted without
 * resurrecting ghost active directories.
 */

import { z } from 'zod';
import * as path from 'path';
import { isFileNotFound, type FileSystem } from '../../foundation/fs/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { formatErr } from '../../foundation/node-utils/index.js';
import { ToolError } from '../../foundation/tools/index.js';
import { CONTRACT_LIFECYCLE_INTENTS_DIR } from './dirs.js';
import {
  ARCHIVE_STATES,
  type ContractId,
  type ContractCorruptionEvidence,
  type ContractFailure,
  type LifecycleIntent,
  type LifecycleIntentIssue,
} from './types.js';
import { CONTRACT_AUDIT_EVENTS } from './audit-events.js';

export const LIFECYCLE_INTENT_SCHEMA_VERSION = 1 as const;

const ContractCorruptionEvidenceSchema = z.object({
  reason: z.enum([
    'yaml_parse_error',
    'yaml_schema_invalid',
    'progress_json_parse_error',
    'progress_schema_invalid',
    'progress_unknown_schema_version',
  ]),
  relativePath: z.string().min(1),
}).strict();

const BaseLifecycleIntentSchema = z.object({
  schema_version: z.literal(LIFECYCLE_INTENT_SCHEMA_VERSION),
  request_id: z.string().min(1),
  contract_id: z.string().min(1),
  requested_state: z.enum([...ARCHIVE_STATES] as [string, ...string[]]),
  requested_at: z.string().min(1),
}).strict();

const CompletedLifecycleIntentSchema = BaseLifecycleIntentSchema.extend({
  requested_state: z.literal('completed'),
  context: z.string().min(1),
}).strict();

const CancelledLifecycleIntentSchema = BaseLifecycleIntentSchema.extend({
  requested_state: z.literal('cancelled'),
  reason: z.string().min(1),
}).strict();

export const CorruptedLifecycleIntentSchema = BaseLifecycleIntentSchema.extend({
  requested_state: z.literal('corrupted'),
  evidence: ContractCorruptionEvidenceSchema,
}).strict();

/** Phase 1396 Step D: typed execution-failure payload for failed intents. */
export const ContractFailureSchema = z.object({
  reason: z.string().min(1),
  evidenceRef: z.string().min(1),
  producer: z.string().min(1),
}).strict();

export const FailedLifecycleIntentSchema = BaseLifecycleIntentSchema.extend({
  requested_state: z.literal('failed'),
  failure: ContractFailureSchema,
}).strict();

export const LifecycleIntentSchema = z.discriminatedUnion('requested_state', [
  CompletedLifecycleIntentSchema,
  CancelledLifecycleIntentSchema,
  CorruptedLifecycleIntentSchema,
  FailedLifecycleIntentSchema,
]);

export interface ReadLifecycleIntentsResult {
  intents: LifecycleIntent[];
  issues: LifecycleIntentIssue[];
}

export function lifecycleIntentDir(baseDir: string, contractId: ContractId): string {
  return path.join(baseDir, CONTRACT_LIFECYCLE_INTENTS_DIR, contractId);
}

export function lifecycleIntentPath(baseDir: string, contractId: ContractId, requestId: string): string {
  return path.join(lifecycleIntentDir(baseDir, contractId), `${requestId}.json`);
}

function isAlreadyExists(err: unknown): boolean {
  return isFileNotFound(err) === false && err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EEXIST';
}

/**
 * Deep-equality for intent payloads. Uses JSON-stable comparison on the
 * subset of fields that define the request fact.
 */
function sameIntentPayload(a: LifecycleIntent, b: LifecycleIntent): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function emitIntentPersisted(audit: AuditLog, intent: LifecycleIntent): void {
  audit.write(
    CONTRACT_AUDIT_EVENTS.LIFECYCLE_INTENT_PERSISTED,
    `contractId=${intent.contract_id}`,
    `requestId=${intent.request_id}`,
    `requested_state=${intent.requested_state}`,
  );
}

function emitIntentReadIssue(audit: AuditLog, issue: LifecycleIntentIssue): void {
  audit.write(
    CONTRACT_AUDIT_EVENTS.LIFECYCLE_INTENT_READ_ISSUE,
    `contractId=${path.basename(path.dirname(issue.path))}`,
    `requestId=${issue.requestId}`,
    `reason=${issue.reason}`,
    issue.detail ? `detail=${issue.detail}` : '',
  );
}

/**
 * Persist an immutable lifecycle intent with exclusive create semantics.
 *
 * - requestId is caller-generated and reused on retry.
 * - EEXIST with identical payload is idempotent.
 * - EEXIST with different payload is a hard identity collision.
 * - Parent directories are auto-created by the filesystem layer; this is not
 *   treated as lifecycle authority.
 */
export async function persistLifecycleIntent(
  fs: FileSystem,
  audit: AuditLog,
  baseDir: string,
  intent: LifecycleIntent,
): Promise<void> {
  const filePath = lifecycleIntentPath(baseDir, intent.contract_id as ContractId, intent.request_id);
  const serialized = JSON.stringify(intent, null, 2);

  try {
    await fs.writeExclusive(filePath, serialized);
  } catch (err) {
    if (isAlreadyExists(err)) {
      const existing = await readLifecycleIntent(fs, filePath);
      if (existing && sameIntentPayload(existing, intent)) {
        emitIntentPersisted(audit, intent);
        return;
      }
      throw new ToolError(
        `Lifecycle intent collision for request "${intent.request_id}" on contract "${intent.contract_id}"`,
      );
    }
    throw err;
  }

  emitIntentPersisted(audit, intent);
}

export async function readLifecycleIntent(
  fs: FileSystem,
  filePath: string,
): Promise<LifecycleIntent | null> {
  let raw: string;
  try {
    raw = await fs.read(filePath);
  } catch (err) {
    if (isFileNotFound(err)) return null;
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const result = LifecycleIntentSchema.safeParse(parsed);
  if (!result.success) return null;
  return result.data as LifecycleIntent;
}

/**
 * Read all valid lifecycle intents for a contract from the stable store.
 *
 * Malformed files become typed issues and are reported without hiding other
 * valid intents. Intents are sorted by (requested_at, request_id) only for
 * deterministic display; the order does not imply a winner.
 */
export async function readLifecycleIntentsForContract(
  fs: FileSystem,
  audit: AuditLog,
  baseDir: string,
  contractId: ContractId,
): Promise<ReadLifecycleIntentsResult> {
  const dir = lifecycleIntentDir(baseDir, contractId);
  const intents: LifecycleIntent[] = [];
  const issues: LifecycleIntentIssue[] = [];

  let entries: { name: string; isDirectory: boolean }[] = [];
  try {
    if (await fs.exists(dir)) {
      entries = await fs.list(dir, { includeDirs: false });
    }
  } catch (err) {
    audit.write(
      CONTRACT_AUDIT_EVENTS.LIFECYCLE_INTENT_READ_ISSUE,
      `contractId=${contractId}`,
      `reason=list_failed`,
      `detail=${formatErr(err)}`,
    );
    return { intents: [], issues: [] };
  }

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (!entry.name.endsWith('.json')) continue;
    const requestId = entry.name.slice(0, -5);
    const filePath = `${dir}/${entry.name}`;

    let raw: string;
    try {
      raw = await fs.read(filePath);
    } catch (err) {
      issues.push({
        requestId,
        path: filePath,
        reason: 'parse_failed',
        detail: formatErr(err),
      });
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      issues.push({
        requestId,
        path: filePath,
        reason: 'parse_failed',
        detail: formatErr(err),
      });
      continue;
    }

    const result = LifecycleIntentSchema.safeParse(parsed);
    if (!result.success) {
      issues.push({
        requestId,
        path: filePath,
        reason: 'schema_invalid',
        detail: result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
      continue;
    }

    if (result.data.contract_id !== contractId) {
      issues.push({
        requestId,
        path: filePath,
        reason: 'identity_mismatch',
        detail: `expected=${contractId} actual=${result.data.contract_id}`,
      });
      continue;
    }

    intents.push(result.data);
  }

  for (const issue of issues) {
    emitIntentReadIssue(audit, issue);
  }

  intents.sort((a, b) => {
    const ta = a.requested_at.localeCompare(b.requested_at);
    if (ta !== 0) return ta;
    return a.request_id.localeCompare(b.request_id);
  });

  return { intents, issues };
}

export function buildCompletedIntent(
  contractId: ContractId,
  requestId: string,
  context: string,
): LifecycleIntent {
  return {
    schema_version: LIFECYCLE_INTENT_SCHEMA_VERSION,
    request_id: requestId,
    contract_id: contractId,
    requested_state: 'completed',
    requested_at: new Date().toISOString(),
    context,
  };
}

export function buildCancelledIntent(
  contractId: ContractId,
  requestId: string,
  reason: string,
): LifecycleIntent {
  return {
    schema_version: LIFECYCLE_INTENT_SCHEMA_VERSION,
    request_id: requestId,
    contract_id: contractId,
    requested_state: 'cancelled',
    requested_at: new Date().toISOString(),
    reason,
  };
}

export function buildCorruptedIntent(
  contractId: ContractId,
  requestId: string,
  evidence: ContractCorruptionEvidence,
): LifecycleIntent {
  return {
    schema_version: LIFECYCLE_INTENT_SCHEMA_VERSION,
    request_id: requestId,
    contract_id: contractId,
    requested_state: 'corrupted',
    requested_at: new Date().toISOString(),
    evidence,
  };
}

/**
 * Phase 1396 Step D: build a failed terminal intent carrying the typed failure fact.
 */
export function buildFailedIntent(
  contractId: ContractId,
  requestId: string,
  failure: ContractFailure,
): LifecycleIntent {
  return {
    schema_version: LIFECYCLE_INTENT_SCHEMA_VERSION,
    request_id: requestId,
    contract_id: contractId,
    requested_state: 'failed',
    requested_at: new Date().toISOString(),
    failure,
  };
}
