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
import { isFileNotFound } from '../../foundation/fs/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { ContractYamlSchema } from './schemas.js';
import { type ContractId, type ArchiveDir, ARCHIVE_STATES } from './types.js';
import { CONTRACT_AUDIT_EVENTS } from './audit-events.js';
import type { SubtaskStatus } from './types.js';

export const CREATION_CLAIM_FILE = '.creating';

/**
 * Phase 1911 Step F：verifier 资产的 owner 控制 staging 目录（claim 目录内、
 * 未发布合同的消费者不可见语义由 `.creating` 拓扑保证）。
 */
export const CREATION_ASSETS_STAGING_DIR = '.creating-assets';
/** 资产发布目标（contractRoot 内子目录名，与 getContractVerificationDir 一致）。 */
export const VERIFICATION_DIR_NAME = 'verification';

const VerificationAssetManifestEntrySchema = z.object({
  name: z.string(),
  bytes: z.number().int().nonnegative(),
}).strict();

const ContractCreationIntentSchema = z.object({
  schema_version: z.literal(1),
  contract_id: z.string(),
  started_at: z.string().datetime(),
  contract: ContractYamlSchema,
  // Phase 1911 Step F：资产 manifest（name+bytes）；缺省 = 无资产 legacy intent
  verification_assets: z.array(VerificationAssetManifestEntrySchema).optional(),
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
 * Phase 1911 Step F：assets 以 manifest（name+bytes）记入 intent，字节本体
 * 落 `.creating-assets/` staging —— 恢复不依赖外部源路径。
 */
export function buildCreationIntent(
  contract: z.infer<typeof ContractYamlSchema>,
  contractId: ContractId,
  startedAt: string,
  assets?: readonly { name: string; content: string }[],
): ContractCreationIntent {
  return {
    schema_version: 1,
    contract_id: contractId,
    started_at: startedAt,
    contract,
    ...(assets && assets.length > 0
      ? {
          verification_assets: assets.map((a) => ({
            name: a.name,
            bytes: Buffer.byteLength(a.content, 'utf-8'),
          })),
        }
      : {}),
  };
}

/**
 * Phase 1911 Step F：把 verifier 资产字节写入 owner 控制的 durable staging。
 * 幂等（writeAtomic 同内容覆写本 staging 内同名文件）。
 */
export async function stageVerificationAssets(opts: {
  fs: FileSystem;
  activeDir: string;
  contractId: ContractId;
  assets: readonly { name: string; content: string }[],
}): Promise<void> {
  const { fs, activeDir, contractId, assets } = opts;
  if (assets.length === 0) return;
  const stagingDir = `${activeDir}/${contractId}/${CREATION_ASSETS_STAGING_DIR}`;
  for (const asset of assets) {
    await fs.writeAtomic(`${stagingDir}/${asset.name}`, asset.content);
  }
}

/**
 * Phase 1911 Step F：按 intent manifest 把 staging 资产发布进 verification/。
 * 幂等：已落位且 bytes 匹配的条目跳过；staging 缺失/尺寸不符 → 'incomplete'
 * （fail-closed，保留证据，不 publish）。无 manifest 的 legacy intent → 'none'
 * （但 staging 目录残留非空属异常 → 'incomplete'）。
 */
export async function materializeVerificationAssets(opts: {
  fs: FileSystem;
  activeDir: string;
  contractId: ContractId;
  intent: ContractCreationIntent;
}): Promise<'none' | 'ok' | 'incomplete'> {
  const { fs, activeDir, contractId, intent } = opts;
  const contractRoot = `${activeDir}/${contractId}`;
  const stagingDir = `${contractRoot}/${CREATION_ASSETS_STAGING_DIR}`;
  const manifest = intent.verification_assets ?? [];

  if (manifest.length === 0) {
    if (!(await fs.exists(stagingDir))) return 'none';
    const leftover = await fs.list(stagingDir).catch(() => []);
    return leftover.length === 0 ? 'none' : 'incomplete';
  }

  await fs.ensureDir(`${contractRoot}/${VERIFICATION_DIR_NAME}`);
  for (const entry of manifest) {
    const destPath = `${contractRoot}/${VERIFICATION_DIR_NAME}/${entry.name}`;
    const stagedPath = `${stagingDir}/${entry.name}`;
    if (await fs.exists(destPath)) {
      // 已落位（恢复重跑幂等）：尺寸必须匹配 manifest，否则属篡改/半成品
      const stat = await fs.stat(destPath).catch(() => null);
      if (!stat || stat.size !== entry.bytes) return 'incomplete';
      continue;
    }
    const stagedStat = await fs.stat(stagedPath).catch(() => null);
    if (!stagedStat || stagedStat.size !== entry.bytes) return 'incomplete';
    await fs.move(stagedPath, destPath); // 同 fs rename，原子落位
  }
  // staging 腾空后移除目录（恢复重跑时可能已不存在）
  if (await fs.exists(stagingDir)) {
    const rest = await fs.list(stagingDir).catch(() => []);
    if (rest.length === 0) {
      await fs.removeDir(stagingDir).catch(() => {
        // silent: 清理失败不影响已落位事实；残留空 staging 由下次恢复再试
      });
    }
  }
  return 'ok';
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
function parseCreationIntent(raw: string): ContractCreationIntent | null {
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

  // Phase 1911 Step F：publish 前按 intent manifest 恢复 verifier 资产 ——
  // 不完整（staging 缺字节/尺寸不符/篡改）→ fail-closed 保留证据，不发布。
  const assetsResult = await materializeVerificationAssets({ fs, activeDir, contractId, intent });
  if (assetsResult === 'incomplete') {
    audit.write(
      CONTRACT_AUDIT_EVENTS.CONTRACT_CREATION_RECOVERY_FAILED,
      `contractId=${contractId}`,
      `started_at=${intent.started_at}`,
      `reason=assets_incomplete`,
      `error=verification assets staging does not match durable intent manifest`,
    );
    return;
  }

  try {
    await materializeClaimedCreation({ fs, activeDir, contractId, intent });
    await publishCreation({ fs, activeDir, contractId });
  } catch (err) {
    // Phase 1910 Step C: 并发 recovery/adopt 下 winner 可能已先行 publish ——
    // publish 的 claim delete 遇 ENOENT 等价于「已被同一 intent 发布」，不是失败。
    if (isFileNotFound(err) && !(await fs.exists(claimPath))) {
      audit.write(
        CONTRACT_AUDIT_EVENTS.CONTRACT_CREATION_RECOVERED,
        `contractId=${contractId}`,
        `started_at=${intent.started_at}`,
      );
      return;
    }
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
