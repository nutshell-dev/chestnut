/**
 * @module L4.ContractSystem.Creation
 * Phase 1197: contract creation exclusive publish protocol.
 *
 * Creation authority is granted by an exclusive temporary claim file (`.creating`).
 * A contract is only visible to normal active consumers after the claim file is
 * atomically deleted (publish commit).
 */

import { z } from 'zod';
import * as yaml from 'js-yaml';
import type { FileSystem } from '../../foundation/fs/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { ContractYamlSchema } from './schemas.js';
import { type ContractId, type ArchiveDir, ARCHIVE_STATES } from './types.js';
import { CONTRACT_AUDIT_EVENTS } from './audit-events.js';
import type { SubtaskStatus } from './types.js';

export const CREATION_CLAIM_FILE = '.creating';

export const ContractCreationIntentSchema = z.object({
  schema_version: z.literal(1),
  contract_id: z.string(),
  started_at: z.string().datetime(),
  contract: ContractYamlSchema,
}).strict();

type ContractCreationIntent = z.infer<typeof ContractCreationIntentSchema>;

type ActivePublication =
  | { kind: 'unpublished'; reason: 'creating' }
  | { kind: 'published' };

/**
 * Classify the publication state of a physical active contract root by marker topology.
 *
 * Visibility rules:
 * - `.creating` present → unpublished
 * - `.creating` absent → published (both new create-after-publish and pre-phase1197 legacy)
 *
 * This helper does NOT read intent content; recovery validation is decoupled from hot reads.
 * Expected marker presence/absence does not emit audit.
 */
export async function classifyActivePublication(opts: {
  fs: FileSystem;
  contractRoot: string;
}): Promise<ActivePublication> {
  const { fs, contractRoot } = opts;
  const creatingPath = `${contractRoot}/${CREATION_CLAIM_FILE}`;

  if (await fs.exists(creatingPath)) {
    return { kind: 'unpublished', reason: 'creating' };
  }

  return { kind: 'published' };
}

/**
 * Synchronous variant of classifyActivePublication for 0-instance lightweight helpers.
 */
export function classifyActivePublicationSync(opts: {
  fs: FileSystem;
  contractRoot: string;
}): ActivePublication {
  const { fs, contractRoot } = opts;
  const creatingPath = `${contractRoot}/${CREATION_CLAIM_FILE}`;

  if (fs.existsSync?.(creatingPath) ?? false) {
    return { kind: 'unpublished', reason: 'creating' };
  }

  return { kind: 'published' };
}

/**
 * Narrow helper: a published classification is visible to normal active consumers.
 */
export function isActivePublished(pub: ActivePublication): boolean {
  return pub.kind === 'published';
}

/**
 * Build a durable creation intent from a validated contract YAML.
 */
export function buildCreationIntent(
  contract: z.infer<typeof ContractYamlSchema>,
  contractId: ContractId,
  startedAt: string,
): ContractCreationIntent {
  return {
    schema_version: 1,
    contract_id: contractId,
    started_at: startedAt,
    contract,
  };
}

/**
 * Locate an existing archive entry for a contract id across current terminal
 * state directories and legacy flat archive. Returns the first collision path
 * or null if absent.
 *
 * This helper is read-only and only answers collision location; it does not
 * grant creation authority.
 */
export async function findArchiveCollisionLocation(opts: {
  fs: FileSystem;
  archiveDir: ArchiveDir;
  contractId: ContractId;
}): Promise<string | null> {
  const { fs, archiveDir, contractId } = opts;
  for (const state of ARCHIVE_STATES) {
    const candidate = `${archiveDir}/${state}/${contractId}`;
    if (await fs.exists(candidate)) return candidate;
  }
  const legacy = `${archiveDir}/${contractId}`;
  if (await fs.exists(legacy)) return legacy;
  return null;
}

/**
 * Detect exclusive-write failure (EEXIST) from FileSystem.writeExclusive.
 */
export function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'EEXIST'
  );
}

/**
 * Serialize intent to the claim file. Stable JSON with deterministic field order.
 */
export function serializeCreationIntent(intent: ContractCreationIntent): string {
  return JSON.stringify(intent, null, 2);
}

/**
 * Parse and validate a durable creation intent. Returns null if malformed.
 */
export function parseCreationIntent(raw: string): ContractCreationIntent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = ContractCreationIntentSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/**
 * Materialize the contract payload from a durable intent.
 *
 * Idempotent: repeated calls overwrite the same files with the same semantic content
 * (contract.yaml and progress.json derived strictly from intent; no new timestamps).
 */
export async function materializeClaimedCreation(opts: {
  fs: FileSystem;
  activeDir: string;
  contractId: ContractId;
  intent: ContractCreationIntent;
}): Promise<void> {
  const { fs, activeDir, contractId, intent } = opts;
  const contractRoot = `${activeDir}/${contractId}`;

  const contractYaml = intent.contract;
  const content = yaml.dump({
    schema_version: contractYaml.schema_version ?? 1,
    id: contractId,
    title: contractYaml.title,
    background: contractYaml.background,
    goal: contractYaml.goal,
    expectations: contractYaml.expectations,
    subtasks: contractYaml.subtasks,
    verification: contractYaml.verification ?? [],
    verification_attempts: contractYaml.verification_attempts,
    audit_interval: contractYaml.audit_interval,
    auth_level: contractYaml.auth_level ?? 'auto',
  });
  await fs.writeAtomic(`${contractRoot}/contract.yaml`, content);

  const persisted = {
    schema_version: 1, // mirror PROGRESS_CURRENT_SCHEMA_VERSION in persistence.ts
    subtasks: Object.fromEntries(
      contractYaml.subtasks.map((st: { id: string }) => [st.id, { status: 'todo' as SubtaskStatus }])
    ),
    started_at: intent.started_at,
    checkpoint: null,
  };
  await fs.writeAtomic(`${contractRoot}/progress.json`, JSON.stringify(persisted, null, 2));
}

/**
 * Publish a claimed creation by deleting the `.creating` marker.
 */
export async function publishCreation(opts: {
  fs: FileSystem;
  activeDir: string;
  contractId: ContractId;
}): Promise<void> {
  const { fs, activeDir, contractId } = opts;
  await fs.delete(`${activeDir}/${contractId}/${CREATION_CLAIM_FILE}`);
}

/**
 * Boot recovery: validate durable intent under a `.creating` directory and complete publish.
 *
 * - Malformed intent: emit recovery_failed, leave directory untouched, do not publish.
 * - Valid intent: idempotently materialize payload, delete `.creating`, emit recovered + created.
 */
export async function recoverUnpublishedCreation(opts: {
  fs: FileSystem;
  audit: AuditLog;
  activeDir: string;
  archiveDir: ArchiveDir;
  contractId: ContractId;
}): Promise<void> {
  const { fs, audit, activeDir, archiveDir, contractId } = opts;
  const claimPath = `${activeDir}/${contractId}/${CREATION_CLAIM_FILE}`;

  let raw: string;
  try {
    raw = await fs.read(claimPath);
  } catch (err) {
    audit.write(
      CONTRACT_AUDIT_EVENTS.CONTRACT_CREATION_RECOVERY_FAILED,
      `contractId=${contractId}`,
      `reason=claim_read_failed`,
      `error=${formatErr(err)}`,
    );
    return;
  }

  const intent = parseCreationIntent(raw);
  if (!intent) {
    audit.write(
      CONTRACT_AUDIT_EVENTS.CONTRACT_CREATION_RECOVERY_FAILED,
      `contractId=${contractId}`,
      `reason=intent_schema_invalid`,
      `error=failed to parse ContractCreationIntent`,
    );
    return;
  }

  // Phase 1197 Step C: recovery must re-prove identity authority.
  if (intent.contract_id !== contractId) {
    audit.write(
      CONTRACT_AUDIT_EVENTS.CONTRACT_CREATION_RECOVERY_FAILED,
      `contractId=${contractId}`,
      `path_id=${contractId}`,
      `intent_contract_id=${intent.contract_id}`,
      `reason=intent_contract_id_mismatch`,
      `error=intent contract_id does not match active path`,
    );
    return;
  }
  const yamlId = intent.contract.id;
  if (yamlId !== undefined && yamlId !== contractId) {
    audit.write(
      CONTRACT_AUDIT_EVENTS.CONTRACT_CREATION_RECOVERY_FAILED,
      `contractId=${contractId}`,
      `path_id=${contractId}`,
      `yaml_id=${yamlId}`,
      `reason=contract_yaml_id_mismatch`,
      `error=contract yaml id does not match active path`,
    );
    return;
  }

  // Phase 1197 Step C: recovery must re-prove archive uniqueness.
  const collision = await findArchiveCollisionLocation({ fs, archiveDir, contractId });
  if (collision) {
    audit.write(
      CONTRACT_AUDIT_EVENTS.CONTRACT_CREATION_RECOVERY_FAILED,
      `contractId=${contractId}`,
      `started_at=${intent.started_at}`,
      `reason=archive_collision`,
      `collision_path=${collision}`,
      `error=contract id already exists in archive`,
    );
    return;
  }

  try {
    await materializeClaimedCreation({ fs, activeDir, contractId, intent });
    await publishCreation({ fs, activeDir, contractId });
  } catch (err) {
    audit.write(
      CONTRACT_AUDIT_EVENTS.CONTRACT_CREATION_RECOVERY_FAILED,
      `contractId=${contractId}`,
      `started_at=${intent.started_at}`,
      `reason=publish_failed`,
      `error=${formatErr(err)}`,
    );
    return;
  }

  audit.write(
    CONTRACT_AUDIT_EVENTS.CONTRACT_CREATION_RECOVERED,
    `contractId=${contractId}`,
    `started_at=${intent.started_at}`,
  );
  audit.write(
    CONTRACT_AUDIT_EVENTS.CREATED,
    `contractId=${contractId}`,
    `subtasks=${intent.contract.subtasks.length}`,
    `title=${intent.contract.title}`,
    `recovered=true`,
  );
}

function formatErr(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
