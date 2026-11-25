/**
 * @module L4.LLMConfiguration.DocumentStore
 *
 * 工作区共享 LLM 配置的唯一持久化 owner。根 config.yaml 的非 LLM 字段仍归
 * Assembly；本模块只拥有 .chestnut/llm/config.yaml、修订与迁移证据。
 */
import * as path from 'path';
import { z } from 'zod';
import {
  configExists,
  isConfigStoreError,
  loadYamlConfig,
  readYamlDocument,
  withYamlConfigLock,
  writeYamlConfig,
  writeYamlConfigExclusive,
} from '../../foundation/config-store/index.js';
import { getChestnutRoot } from '../../foundation/claw-identity/index.js';
import type { AtomicWriteResult, FileSystem } from '../../foundation/fs/index.js';
import { llmOrchestratorConfigSchema, llmOrchestratorRuntimeConfigSchema } from './config-schema.js';
import { llmProviderConfigContract } from '../../foundation/llm-provider/index.js';
const { strictLLMProviderConfigSchema, PROVIDER_NO_LABEL_SENTINEL } = llmProviderConfigContract;
import { formatErr, newShortUuid, newUuid, sha256Hex } from '../../foundation/node-utils/index.js';
import {
  createLocalCredentials,
  type CredentialFact,
  type CredentialSource,
  type ResolvedCredential,
} from './legacy-credentials/index.js';
import type {
  LLMProviderSlot,
  LLMRawConfigView,
  SharedLLM,
  SharedLLMInput,
} from './selection.js';
import {
  LLMConfigurationCredentialUnavailableError,
  type MissingCredentialTarget,
} from './credential-errors.js';
import { assertNoLegacyPlaintextApiKey } from './key-input.js';
import {
  migrateLegacyApiKeysAtPath,
  type ApiKeyMigrationAudit,
  type ApiKeyMigrationOutcome,
} from './api-key-migration.js';
import {
  LegacyPresetMigrationError,
  migrateLegacyLLMConfig,
  migrateLegacyProviderConfig,
} from './preset-migration.js';

const DOCUMENT_SCHEMA_VERSION = 1 as const;
const documentMetadataSchema = z.object({
  schema_version: z.literal(DOCUMENT_SCHEMA_VERSION),
  revision: z.number().int().positive(),
});
const resolvedDocumentSchema = llmOrchestratorRuntimeConfigSchema.extend({
  schema_version: z.literal(DOCUMENT_SCHEMA_VERSION),
  revision: z.number().int().positive(),
});

export type LLMConfigDocument = SharedLLMInput & z.infer<typeof documentMetadataSchema>;
export type ResolvedLLMConfigDocument = SharedLLM & z.infer<typeof documentMetadataSchema>;
export type LLMConfigurationWriteResult = AtomicWriteResult;
export type LLMConfigurationDocumentMigrationResult =
  | { readonly outcome: 'noop' }
  | {
    readonly outcome: 'migrated';
    readonly migrationId: string;
    readonly sourceRevision: number;
    readonly targetRevision: number;
    readonly write: LLMConfigurationWriteResult;
  };
export type ExplicitLLMProviderConfig = z.input<typeof strictLLMProviderConfigSchema>;
export type LLMSetupCommitTarget =
  | { readonly kind: 'initialize' }
  | { readonly kind: 'primary' }
  | { readonly kind: 'fallback'; readonly position?: number }
  | { readonly kind: 'replace'; readonly slot: LLMProviderSlot };

export interface AssignMissingLLMProviderLabel {
  readonly slot: LLMProviderSlot;
  readonly expectedRevisionId: string;
  readonly expectedFingerprint: string;
  readonly label: string;
}

export interface LLMConfigurationCommitResult {
  readonly target: LLMSetupCommitTarget;
  readonly revision: LLMConfigurationRevision;
  readonly write: LLMConfigurationWriteResult;
  /** 与实际写入 revision 同一把锁内重读的 raw 文档；提交不解析凭据。 */
  readonly document: LLMConfigDocument;
}

export interface LLMConfigurationRevision {
  /** 持久保存序号；配置 identity 仍由 resolved 配置单独派生。 */
  readonly id: string;
  readonly revision: number;
}

export interface LLMConfigurationDocumentStore {
  /** 原始 schema 校验读取；不展开 `${REF}`，也不写盘。 */
  read(): LLMConfigDocument;
  /** 展开引用并应用 owner schema defaults，供运行/probe 使用。 */
  readResolved(): ResolvedLLMConfigDocument;
  /** raw 与 resolved 来自同一次磁盘读取，供 scope/auth snapshot 使用。 */
  readSnapshot(): {
    raw: LLMConfigDocument;
    resolved: ResolvedLLMConfigDocument;
    credentialSources: Readonly<Record<string, CredentialSource>>;
    credentialFacts: Readonly<Record<string, CredentialFact>>;
  };
  migrateLegacyApiKeys(audit?: ApiKeyMigrationAudit): Promise<readonly ApiKeyMigrationOutcome[]>;
  /** 显式迁移既有 shared legacy 文档；正常读取不会隐式调用。 */
  migrateLegacyDocument(): Promise<LLMConfigurationDocumentMigrationResult>;
  readRevision(): LLMConfigurationRevision;
  /** 锁内重读 raw 文档；调用方返回完整新文档，revision 由 store 单调推进。 */
  mutate(
    fn: (fresh: LLMConfigDocument) => LLMConfigDocument,
  ): Promise<LLMConfigurationWriteResult>;
  /** Compatibility write: name exactly one historical entry; other missing labels may remain. */
  assignMissingLabel(
    request: AssignMissingLLMProviderLabel,
  ): Promise<LLMConfigurationCommitResult>;
  patchPrimary(patch: Readonly<Record<string, unknown>>): Promise<LLMConfigurationWriteResult>;
  /** setup 的唯一业务提交口；target 之外的文档重建均由 store 负责。 */
  commitExplicitProvider(
    target: LLMSetupCommitTarget,
    explicitConfig: ExplicitLLMProviderConfig,
    expectedRevision?: number,
  ): Promise<LLMConfigurationCommitResult>;
  /** 独占创建或核验同内容目标；在确认前不得清理迁移源。 */
  createFromSource(
    source: SharedLLMInput,
    migrationId: string,
  ): LLMConfigurationWriteResult;
}

export interface LLMConfigurationAdmin {
  loadGlobal(): import('./selection.js').LLMGlobalConfigView;
  /** Raw management reads never resolve credentials or materialize defaults. */
  loadRaw(): LLMRawConfigView;
  /** 配置与 revision 同次磁盘读取，禁止把旧配置登记成新 revision。 */
  loadSnapshot(): {
    llm: SharedLLM;
    raw: SharedLLMInput;
    revision: LLMConfigurationRevision;
    workspaceRoot: string;
    credentialSources: Readonly<Record<string, CredentialSource>>;
    credentialFacts: Readonly<Record<string, CredentialFact>>;
  };
  mutateGlobalLocked(
    mutator: (config: { llm: SharedLLMInput; revision: LLMConfigurationRevision }) => void,
  ): Promise<LLMConfigurationWriteResult>;
  assignMissingLabel(
    request: AssignMissingLLMProviderLabel,
  ): Promise<LLMConfigurationCommitResult>;
  patchPrimary(patch: Readonly<Record<string, unknown>>): Promise<LLMConfigurationWriteResult>;
  commitExplicitProvider(
    target: LLMSetupCommitTarget,
    explicitConfig: ExplicitLLMProviderConfig,
    expectedRevision?: number,
  ): Promise<LLMConfigurationCommitResult>;
  migrateLegacyApiKeys(audit?: ApiKeyMigrationAudit): Promise<readonly ApiKeyMigrationOutcome[]>;
  /** 显式迁移既有 shared legacy 文档；正常读取不会隐式调用。 */
  migrateLegacyDocument(): Promise<LLMConfigurationDocumentMigrationResult>;
  readRevision(): LLMConfigurationRevision;
  readonly store: LLMConfigurationDocumentStore;
}

export class LLMConfigurationNotFoundError extends Error {
  constructor(readonly configPath: string) {
    super(`LLM configuration not found: ${configPath}`);
    this.name = 'LLMConfigurationNotFoundError';
  }
}

export class LLMConfigurationAlreadyExistsError extends Error {
  constructor(readonly configPath: string, options?: ErrorOptions) {
    super(`LLM configuration already initialized: ${configPath}`, options);
    this.name = 'LLMConfigurationAlreadyExistsError';
  }
}

export class LLMConfigurationRevisionConflictError extends Error {
  constructor(readonly expectedRevision: number, readonly actualRevision: number) {
    super(`LLM configuration revision conflict: expected=${expectedRevision}, actual=${actualRevision}`);
    this.name = 'LLMConfigurationRevisionConflictError';
  }
}

export class LLMProviderLabelAlreadyExistsError extends Error {
  constructor(readonly label: string) {
    super(`A provider with label "${label}" already exists`);
    this.name = 'LLMProviderLabelAlreadyExistsError';
  }
}

export class LLMProviderLabelInvalidError extends Error {
  constructor() {
    super('Provider label must be non-empty and must not use the reserved no-label sentinel');
    this.name = 'LLMProviderLabelInvalidError';
  }
}

export class LLMProviderEntryIdInvalidError extends Error {
  constructor() {
    super('LLM provider entry_id must be a valid UUID');
    this.name = 'LLMProviderEntryIdInvalidError';
  }
}

export class LLMProviderEntryIdAlreadyExistsError extends Error {
  constructor(readonly entryId: string) {
    super(`An LLM provider with entry_id "${entryId}" already exists`);
    this.name = 'LLMProviderEntryIdAlreadyExistsError';
  }
}

export class LLMConfigurationLabelRequiredError extends Error {
  readonly code = 'provider_label_required';

  constructor(
    readonly revision: LLMConfigurationRevision,
    readonly targets: readonly LLMProviderSlot[],
  ) {
    super('Every LLM provider must have a unique non-empty label');
    this.name = 'LLMConfigurationLabelRequiredError';
  }
}

export class LLMProviderTargetChangedError extends Error {
  constructor() {
    super('LLM provider target changed before naming; no changes applied');
    this.name = 'LLMProviderTargetChangedError';
  }
}

export class LLMConfigurationMigrationError extends Error {
  constructor(
    message: string,
    readonly migrationId: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'LLMConfigurationMigrationError';
  }
}

interface MigrationRecord {
  schema_version: 1;
  migration_id: string;
  source_digest: string;
  target_digest: string;
  source_revision?: number;
  target_revision?: number;
  preset_migration?: boolean;
  /** Non-secret provenance for endpoints supplied only by explicit legacy migration. */
  connection_fact_sources?: readonly { readonly role: string; readonly field: 'base_url'; readonly source: string }[];
  migration_error?: string;
  outcome?: 'pending' | 'migrated' | 'failed';
  target_write: AtomicWriteResult['kind'] | 'not_written';
  source_cleanup: 'pending' | 'failed' | 'durable' | 'committed_platform_limited' | 'committed_durability_unknown';
  cleanup_error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
    .join(',')}}`;
}

/** 原始引用参与摘要；迁移证据不保存 key 或敏感 header 值。 */
export function llmConfigurationSourceDigest(source: SharedLLMInput): string {
  return sha256Hex(stableStringify(source));
}

function documentConfig(document: LLMConfigDocument): SharedLLMInput {
  const { schema_version: _schemaVersion, revision: _revision, ...config } = document;
  return config;
}

function connectionFactSources(
  source: SharedLLMInput,
  target: SharedLLMInput,
): NonNullable<MigrationRecord['connection_fact_sources']> {
  const facts: { role: string; field: 'base_url'; source: string }[] = [];
  const pairs = [
    { role: 'primary', before: source.primary, after: target.primary },
    ...(target.fallbacks ?? []).map((after, index) => ({
      role: `fallbacks[${index}]`, before: source.fallbacks?.[index], after,
    })),
  ];
  for (const { role, before, after } of pairs) {
    const legacy = before as unknown as Record<string, unknown> | undefined;
    if (legacy?.base_url !== undefined || after.base_url === undefined) continue;
    const origin = typeof legacy?.preset === 'string'
      ? `preset:${legacy.preset}`
      : `catalog:${String(legacy?.provider_id ?? after.provider_id)}`;
    facts.push({ role, field: 'base_url', source: origin });
  }
  return facts;
}

const legacyRawProviderSchema = z.record(z.unknown()).refine(
  provider => provider.label !== '(no label)',
  { message: 'label must not use the reserved no-label sentinel' },
);
const legacyRawDocumentSchema = z.object({
  primary: legacyRawProviderSchema,
  fallbacks: z.array(legacyRawProviderSchema).optional(),
}).passthrough();

function usesCredentialRef(value: unknown, ref: string): boolean {
  if (typeof value === 'string') {
    return Array.from(value.matchAll(/\$\{([^}]+)\}/g)).some(match => match[1] === ref);
  }
  if (value === null || typeof value !== 'object') return false;
  return Object.values(value).some(child => usesCredentialRef(child, ref));
}

function locateMissingCredentialTargets(
  raw: LLMConfigDocument,
  ref: string,
): MissingCredentialTarget[] {
  const slots: LLMProviderSlot[] = [
    { role: 'primary' },
    ...(raw.fallbacks ?? []).map((_, index) => ({ role: 'fallback' as const, index })),
  ];
  return slots.flatMap<MissingCredentialTarget>(slot => {
    const provider = slot.role === 'primary' ? raw.primary : raw.fallbacks?.[slot.index];
    if (provider === undefined) return [];
    const { api_key: apiKey, ...rest } = provider;
    const key = usesCredentialRef(apiKey, ref);
    const other = usesCredentialRef(rest, ref);
    return key || other
      ? [{ slot, field: key && other ? 'multiple' : key ? 'api_key' : 'other' }]
      : [];
  });
}

function providerAtSlot(
  document: LLMConfigDocument,
  slot: LLMProviderSlot,
): SharedLLMInput['primary'] {
  const provider = slot.role === 'primary' ? document.primary : document.fallbacks?.[slot.index];
  if (provider === undefined) throw new LLMProviderTargetChangedError();
  return provider;
}

export function llmProviderTargetFingerprint(
  document: LLMConfigDocument,
  slot: LLMProviderSlot,
): string {
  return sha256Hex(stableStringify({ slot, provider: providerAtSlot(document, slot) }));
}

function missingLabelTargets(document: LLMConfigDocument): LLMProviderSlot[] {
  return [
    ...(document.primary.label?.trim() ? [] : [{ role: 'primary' } as const]),
    ...(document.fallbacks ?? []).flatMap((provider, index) =>
      provider.label?.trim() ? [] : [{ role: 'fallback' as const, index }]),
  ];
}

function providerEntries(document: SharedLLMInput): readonly SharedLLMInput['primary'][] {
  return [document.primary, ...(document.fallbacks ?? [])];
}

function assertUniqueProviderEntryIds(document: SharedLLMInput): void {
  const seen = new Set<string>();
  for (const provider of providerEntries(document)) {
    if (provider.entry_id === undefined) continue;
    // The legacy raw fallback deliberately accepts unsupported connection fields,
    // but persistent identity still has one strict validation rule.
    if (!z.string().uuid().safeParse(provider.entry_id).success) {
      throw new LLMProviderEntryIdInvalidError();
    }
    if (seen.has(provider.entry_id)) throw new LLMProviderEntryIdAlreadyExistsError(provider.entry_id);
    seen.add(provider.entry_id);
  }
}

function backfillMissingEntryIds<T extends SharedLLMInput>(document: T): T {
  // Reject caller-introduced duplicates before allocating anything or writing.
  assertUniqueProviderEntryIds(document);
  return {
    ...document,
    primary: {
      ...document.primary,
      entry_id: document.primary.entry_id ?? newUuid(),
    },
    ...(document.fallbacks !== undefined ? {
      fallbacks: document.fallbacks.map(provider => ({
        ...provider,
        entry_id: provider.entry_id ?? newUuid(),
      })),
    } : {}),
  };
}

function assertNormalDocumentLabels(document: LLMConfigDocument): void {
  const missing = missingLabelTargets(document);
  if (missing.length > 0) {
    throw new LLMConfigurationLabelRequiredError(
      { id: String(document.revision), revision: document.revision },
      missing,
    );
  }
  const seen = new Set<string>();
  for (const provider of [document.primary, ...(document.fallbacks ?? [])]) {
    const label = provider.label!.trim();
    if (label === PROVIDER_NO_LABEL_SENTINEL || provider.label !== label) {
      throw new LLMProviderLabelInvalidError();
    }
    if (seen.has(label)) throw new LLMProviderLabelAlreadyExistsError(label);
    seen.add(label);
  }
}

function parseRawDocument(value: unknown, configPath: string): LLMConfigDocument {
  if (!isRecord(value)) {
    throw new Error(`Invalid LLM configuration document: expected object: ${configPath}`);
  }
  const metadata = documentMetadataSchema.parse(value);
  const { schema_version: _schemaVersion, revision: _revision, ...config } = value;
  // 校验但不回写 parse 结果，避免 mutation 将 defaults 物化或展开引用。
  try {
    llmOrchestratorConfigSchema.parse(config);
  } catch {
    // silent: Raw repair/remove must remain available for structurally identifiable legacy
    // slots even when their connection behavior is no longer runtime-supported.
    legacyRawDocumentSchema.parse(config);
  }
  const document = { ...config, ...metadata } as LLMConfigDocument;
  // Keep this outside the legacy fallback: duplicate persistent identities are
  // never made acceptable merely because another legacy field needs repair.
  assertUniqueProviderEntryIds(document);
  return document;
}

export function getLLMConfigurationPath(): string {
  return path.join(getChestnutRoot(), 'llm', 'config.yaml');
}

function getMigrationRecordPath(migrationId: string): string {
  // migrationId 只作为文件名；digest 派生的 id 与 newShortUuid 均不含路径分隔符。
  if (!/^[A-Za-z0-9_-]+$/.test(migrationId)) throw new Error('Invalid LLM migration id');
  return path.join(getChestnutRoot(), 'llm', 'migration', `${migrationId}.yaml`);
}

export function readLLMMigrationRecord(
  deps: { fsFactory(baseDir: string): FileSystem },
  migrationId: string,
): MigrationRecord | undefined {
  const recordPath = getMigrationRecordPath(migrationId);
  if (!configExists(deps, recordPath)) return undefined;
  const raw = readYamlDocument(deps, recordPath);
  if (!isRecord(raw)) throw new Error(`Invalid LLM migration record: ${recordPath}`);
  return raw as unknown as MigrationRecord;
}

export function createLLMConfigurationDocumentStore(deps: {
  fsFactory(baseDir: string): FileSystem;
}): LLMConfigurationDocumentStore {
  const configPath = getLLMConfigurationPath();

  const read = (): LLMConfigDocument => {
    try {
      return parseRawDocument(readYamlDocument(deps, configPath), configPath);
    } catch (error) {
      if (isConfigStoreError(error) && error.code === 'not_found') {
        throw new LLMConfigurationNotFoundError(configPath);
      }
      throw error;
    }
  };

  const readSnapshot = (): {
    raw: LLMConfigDocument;
    resolved: ResolvedLLMConfigDocument;
    credentialSources: Readonly<Record<string, CredentialSource>>;
    credentialFacts: Readonly<Record<string, CredentialFact>>;
  } => {
    let raw: LLMConfigDocument | undefined;
    const credentialSources: Record<string, CredentialSource> = {};
    const credentialFacts: Record<string, CredentialFact> = {};
    const credentialHits = new Map<string, ResolvedCredential | undefined>();
    const credentials = createLocalCredentials({ fsFactory: deps.fsFactory });
    try {
      const resolved = loadYamlConfig<ResolvedLLMConfigDocument>(
        {
          fsFactory: deps.fsFactory,
          resolveEnvVar: (name) => {
            // 同一 ref 在本次 snapshot 中只解析一次，primary/fallback/header 不会跨代。
            if (!credentialHits.has(name)) credentialHits.set(name, credentials.resolve(name));
            const hit = credentialHits.get(name);
            if (hit !== undefined && credentialFacts[name] === undefined) {
              credentialSources[name] = hit.source;
              credentialFacts[name] = {
                source: hit.source,
                revision: sha256Hex(`${hit.source}\0${hit.value}`),
                identityRef: name,
              };
            }
            if (hit === undefined) {
              if (raw === undefined) throw new Error(`LLM configuration raw snapshot was not captured: ${configPath}`);
              throw new LLMConfigurationCredentialUnavailableError({
                kind: 'document',
                revision: { id: String(raw.revision), revision: raw.revision },
                targets: locateMissingCredentialTargets(raw, name),
              });
            }
            return hit.value;
          },
          validateRaw: (value) => {
            assertNoLegacyPlaintextApiKey(value);
            raw = parseRawDocument(value, configPath);
            assertNormalDocumentLabels(raw);
          },
        },
        configPath,
        resolvedDocumentSchema,
      );
      if (raw === undefined) throw new Error(`LLM configuration raw snapshot was not captured: ${configPath}`);
      return { raw, resolved, credentialSources, credentialFacts };
    } catch (error) {
      if (isConfigStoreError(error) && error.code === 'not_found') {
        throw new LLMConfigurationNotFoundError(configPath);
      }
      throw error;
    }
  };

  const readResolved = (): ResolvedLLMConfigDocument => readSnapshot().resolved;

  const writeMigrationRecord = (record: MigrationRecord): AtomicWriteResult =>
    writeYamlConfig(deps, getMigrationRecordPath(record.migration_id), record);

  /** Confirm both the target filename and a newly created llm directory entry. */
  const confirmTargetDurability = (barrierId: string, targetDigest: string): AtomicWriteResult => {
    const targetBarrier = writeYamlConfig(
      deps,
      path.join(getChestnutRoot(), 'llm', `.${barrierId}.target`),
      { migration_id: barrierId, target_digest: targetDigest },
    );
    const parentBarrier = targetBarrier.kind === 'durable'
      ? writeYamlConfig(
        deps,
        path.join(getChestnutRoot(), `.${barrierId}.llm-dir`),
        { migration_id: barrierId },
      )
      : targetBarrier;
    return parentBarrier.kind === 'durable' ? targetBarrier : parentBarrier;
  };

  const recoverPendingDocumentMigration = (
    metadata: z.infer<typeof documentMetadataSchema>,
    targetDigest: string,
  ): LLMConfigurationDocumentMigrationResult | undefined => {
    const migrationDir = path.join(getChestnutRoot(), 'llm', 'migration');
    const migrationFs = deps.fsFactory(migrationDir);
    if (!migrationFs.existsSync('.')) return undefined;
    const matches: MigrationRecord[] = [];
    for (const entry of migrationFs.listSync('.')) {
      if (!entry.isFile || !entry.name.endsWith('.yaml')) continue;
      const migrationId = entry.name.slice(0, -'.yaml'.length);
      const record = readLLMMigrationRecord(deps, migrationId);
      if (
        record?.outcome === 'pending'
        && record.preset_migration === true
        && record.target_digest === targetDigest
        && record.target_revision === metadata.revision
        && typeof record.source_revision === 'number'
      ) {
        matches.push(record);
      }
    }
    if (matches.length === 0) return undefined;
    if (matches.length > 1) {
      throw new LLMConfigurationMigrationError(
        'LLM document migration recovery is ambiguous; pending evidence preserved',
        `document-${targetDigest.slice(0, 24)}`,
      );
    }
    const pending = matches[0]!;
    // The process crashed after the target became visible but before its write
    // result/evidence was recorded. The explicit digest+revision match proves
    // completion, not the original directory-fsync durability.
    const write: AtomicWriteResult = {
      kind: 'committed_durability_unknown',
      error: Object.assign(new Error('LLM migration target durability unknown after crash'), { code: 'EIO' }),
    };
    writeMigrationRecord({
      ...pending,
      outcome: 'migrated',
      target_write: write.kind,
      source_cleanup: write.kind,
    });
    return {
      outcome: 'migrated',
      migrationId: pending.migration_id,
      sourceRevision: pending.source_revision!,
      targetRevision: metadata.revision,
      write,
    };
  };

  const migrateLegacyDocument = async (): Promise<LLMConfigurationDocumentMigrationResult> => {
    let result: LLMConfigurationDocumentMigrationResult | undefined;
    await withYamlConfigLock(deps, configPath, () => {
      let raw: unknown;
      try {
        raw = readYamlDocument(deps, configPath);
      } catch (error) {
        if (isConfigStoreError(error) && error.code === 'not_found') {
          result = { outcome: 'noop' };
          return;
        }
        // Malformed YAML has no parsed value to digest. Hash only the source bytes
        // for correlatable evidence; never copy parser errors or source text into it.
        let sourceDigest = '';
        try {
          sourceDigest = sha256Hex(
            deps.fsFactory(path.dirname(configPath)).readSync(path.basename(configPath)),
          );
        } catch {
          // silent: the original read error remains authoritative.
        }
        if (sourceDigest) {
          const migrationId = `document-${sourceDigest.slice(0, 24)}`;
          try {
            writeMigrationRecord({
              schema_version: 1,
              migration_id: migrationId,
              source_digest: sourceDigest,
              target_digest: '',
              outcome: 'failed',
              migration_error: 'invalid_source: document',
              target_write: 'not_written',
              source_cleanup: 'pending',
            });
          } catch {
            // silent: evidence failure must not mask the original corruption.
          }
        }
        throw error;
      }

      const source = isRecord(raw)
        ? (() => {
          const { schema_version: _schemaVersion, revision: _revision, ...config } = raw;
          return config;
        })()
        : raw;
      const sourceDigest = llmConfigurationSourceDigest(source as SharedLLMInput);
      const sourceRevision = isRecord(raw) && typeof raw.revision === 'number'
        ? raw.revision
        : undefined;
      const migrationId = `document-${sourceDigest.slice(0, 24)}`;
      const writeFailure = (error: unknown): void => {
        const evidence: MigrationRecord = {
          schema_version: 1,
          migration_id: migrationId,
          source_digest: sourceDigest,
          target_digest: '',
          ...(sourceRevision !== undefined ? { source_revision: sourceRevision } : {}),
          outcome: 'failed',
          migration_error: error instanceof LegacyPresetMigrationError
            ? `${error.code}: ${error.role}`
            : 'invalid_source: document',
          target_write: 'not_written',
          source_cleanup: 'pending',
        };
        try { writeMigrationRecord(evidence); } catch {
          // silent: fail-closed source error remains authoritative.
        }
      };

      let metadata: z.infer<typeof documentMetadataSchema>;
      let migration: ReturnType<typeof migrateLegacyLLMConfig>;
      try {
        metadata = documentMetadataSchema.parse(raw);
        migration = migrateLegacyLLMConfig(source);
      } catch (error) {
        writeFailure(error);
        throw error;
      }
      if (!migration.migrated) {
        result = recoverPendingDocumentMigration(metadata, sourceDigest) ?? { outcome: 'noop' };
        return;
      }

      const targetRevision = metadata.revision + 1;
      const targetDigest = llmConfigurationSourceDigest(migration.config);
      // Persist the complete recovery identity before replacing the source. If
      // the process dies after the target write, a later explicit read can match
      // this pending record and finish the evidence instead of reporting noop.
      writeMigrationRecord({
        schema_version: 1,
        migration_id: migrationId,
        source_digest: sourceDigest,
        target_digest: targetDigest,
        source_revision: metadata.revision,
        target_revision: targetRevision,
        preset_migration: true,
        connection_fact_sources: connectionFactSources(source as SharedLLMInput, migration.config),
        outcome: 'pending',
        target_write: 'not_written',
        source_cleanup: 'pending',
      });
      const write = writeYamlConfig(deps, configPath, {
        ...migration.config,
        schema_version: DOCUMENT_SCHEMA_VERSION,
        revision: targetRevision,
      });
      const confirmed = parseRawDocument(readYamlDocument(deps, configPath), configPath);
      if (
        confirmed.revision !== targetRevision
        || llmConfigurationSourceDigest(documentConfig(confirmed)) !== targetDigest
      ) {
        throw new LLMConfigurationMigrationError(
          `LLM document migration verification failed: ${migrationId}`,
          migrationId,
        );
      }
      writeMigrationRecord({
        schema_version: 1,
        migration_id: migrationId,
        source_digest: sourceDigest,
        target_digest: targetDigest,
        source_revision: metadata.revision,
        target_revision: confirmed.revision,
        preset_migration: true,
        connection_fact_sources: connectionFactSources(source as SharedLLMInput, migration.config),
        outcome: 'migrated',
        target_write: write.kind,
        source_cleanup: write.kind,
      });
      result = {
        outcome: 'migrated',
        migrationId,
        sourceRevision: metadata.revision,
        targetRevision,
        write,
      };
    });
    return result!;
  };

  const createFromSource = (
    source: SharedLLMInput,
    migrationId: string,
  ): AtomicWriteResult => {
    const sourceDigest = llmConfigurationSourceDigest(source);
    const rawSourceRevision = (source as unknown as Record<string, unknown>).revision;
    const sourceRevision = typeof rawSourceRevision === 'number' ? rawSourceRevision : undefined;
    let migration: ReturnType<typeof migrateLegacyLLMConfig>;
    try {
      migration = migrateLegacyLLMConfig(source);
    } catch (error) {
      if (error instanceof LegacyPresetMigrationError) {
        const evidence: MigrationRecord = {
          schema_version: 1,
          migration_id: migrationId,
          source_digest: sourceDigest,
          target_digest: '',
          ...(sourceRevision !== undefined ? { source_revision: sourceRevision } : {}),
          migration_error: `${error.code}: ${error.role}`,
          outcome: 'failed',
          target_write: 'not_written',
          source_cleanup: 'pending',
        };
        try { writeMigrationRecord(evidence); } catch {
          // silent: the typed migration error remains authoritative and no target was written.
        }
      }
      throw error;
    }
    const targetSource = migration.config;
    const {
      schema_version: _sourceSchemaVersion,
      revision: _sourceRevision,
      ...targetConfig
    } = targetSource as unknown as Record<string, unknown>;
    const sourceConfig = llmOrchestratorConfigSchema.parse(targetConfig);
    // Write raw references (never expanded secrets) after explicit migration.
    void sourceConfig;
    if (!configExists(deps, configPath)) {
      try {
        writeYamlConfigExclusive(deps, configPath, {
          ...targetConfig,
          schema_version: DOCUMENT_SCHEMA_VERSION,
          revision: 1,
        });
      } catch (error) {
        if (!isConfigStoreError(error) || error.code !== 'already_exists') {
          const evidence: MigrationRecord = {
            schema_version: 1,
            migration_id: migrationId,
            source_digest: sourceDigest,
            target_digest: '',
            target_write: 'committed_durability_unknown',
            source_cleanup: 'pending',
          };
          try { writeMigrationRecord(evidence); } catch {
            // silent: 目标创建原错误优先，迁移源保持不动；证据写失败不得掩盖原错误。
          }
          throw new LLMConfigurationMigrationError(
            `LLM migration target creation was not confirmed; source preserved: ${migrationId}`,
            migrationId,
            { cause: error },
          );
        }
      }
    }

    let existing: LLMConfigDocument;
    try {
      existing = read();
    } catch (error) {
      throw new LLMConfigurationMigrationError(
        `LLM migration target is unreadable; source preserved: ${migrationId}`,
        migrationId,
        { cause: error },
      );
    }
    const targetDigest = llmConfigurationSourceDigest(documentConfig(existing));
    const expectedTargetDigest = llmConfigurationSourceDigest(targetConfig as SharedLLMInput);
    if (targetDigest !== expectedTargetDigest) {
      throw new LLMConfigurationMigrationError(
        `LLM migration source/target conflict; neither document was cleared or overwritten: ${migrationId}`,
        migrationId,
      );
    }

    // writeExclusiveSync 只 fsync 文件，不证明目录项持久。两个 barrier 分别
    // fsync .chestnut/llm（目标文件名）与 .chestnut（新建 llm 目录项）；
    // 任一未确认都返回非 durable，由 Assembly 保留 root.llm。
    const confirmedBarrier = confirmTargetDurability(migrationId, targetDigest);
    const confirmation = writeMigrationRecord({
      schema_version: 1,
      migration_id: migrationId,
      source_digest: sourceDigest,
      target_digest: targetDigest,
      ...(sourceRevision !== undefined ? { source_revision: sourceRevision } : {}),
      target_revision: existing.revision,
      preset_migration: migration.migrated,
      connection_fact_sources: connectionFactSources(source, targetSource),
      target_write: confirmedBarrier.kind,
      source_cleanup: 'pending',
    });
    if (confirmedBarrier.kind !== 'durable') return confirmedBarrier;
    return confirmation;
  };

  const mutate = async (
    fn: (fresh: LLMConfigDocument) => LLMConfigDocument,
  ): Promise<AtomicWriteResult> => {
    let result: AtomicWriteResult | undefined;
    await withYamlConfigLock(deps, configPath, () => {
      const fresh = read();
      const changed = fn(fresh);
      const metadata = documentMetadataSchema.parse(changed);
      const nextConfig = documentConfig(changed);
      llmOrchestratorConfigSchema.parse(nextConfig);
      // The mutator has completed before legacy entries receive stable IDs.
      const committedConfig = backfillMissingEntryIds(nextConfig);
      assertNormalDocumentLabels({
        ...committedConfig,
        schema_version: DOCUMENT_SCHEMA_VERSION,
        revision: fresh.revision,
      } as LLMConfigDocument);
      result = writeYamlConfig(deps, configPath, {
        ...committedConfig,
        schema_version: DOCUMENT_SCHEMA_VERSION,
        revision: fresh.revision + 1,
        // metadata 输入只允许当前版本；revision 永远由 fresh 推进。
        ...(metadata.schema_version !== DOCUMENT_SCHEMA_VERSION
          ? (() => { throw new Error('Unsupported LLM configuration schema version'); })()
          : {}),
      });
    });
    return result!;
  };

  const assignMissingLabel = async (
    request: AssignMissingLLMProviderLabel,
  ): Promise<LLMConfigurationCommitResult> => {
    let committed: LLMConfigurationCommitResult | undefined;
    await withYamlConfigLock(deps, configPath, () => {
      const fresh = read();
      if (String(fresh.revision) !== request.expectedRevisionId) {
        throw new LLMConfigurationRevisionConflictError(
          Number(request.expectedRevisionId), fresh.revision,
        );
      }
      if (llmProviderTargetFingerprint(fresh, request.slot) !== request.expectedFingerprint) {
        throw new LLMProviderTargetChangedError();
      }
      const target = providerAtSlot(fresh, request.slot);
      if (target.label?.trim()) throw new LLMProviderTargetChangedError();
      const label = request.label.trim();
      if (!label || label === PROVIDER_NO_LABEL_SENTINEL) throw new LLMProviderLabelInvalidError();
      if ([fresh.primary, ...(fresh.fallbacks ?? [])]
        .some(entry => entry.label?.trim() === label)) {
        throw new LLMProviderLabelAlreadyExistsError(label);
      }
      const next = request.slot.role === 'primary'
        ? { ...fresh, primary: { ...target, label } }
        : {
          ...fresh,
          fallbacks: (fresh.fallbacks ?? []).map((entry, index) =>
            index === (request.slot.role === 'fallback' ? request.slot.index : -1)
              ? { ...entry, label }
              : entry),
        };
      // Keep this compatibility transaction narrow: other historical missing labels remain readable.
      const nextConfig = documentConfig(next as LLMConfigDocument);
      llmOrchestratorConfigSchema.parse(nextConfig);
      // Fingerprint/revision guards above still describe the pre-backfill target.
      const committedConfig = backfillMissingEntryIds(nextConfig);
      const revision = fresh.revision + 1;
      const write = writeYamlConfig(deps, configPath, {
        ...committedConfig,
        schema_version: DOCUMENT_SCHEMA_VERSION,
        revision,
      });
      committed = {
        target: { kind: 'replace', slot: request.slot },
        revision: { id: String(revision), revision },
        write,
        document: read(),
      };
    });
    return committed!;
  };

  const patchPrimary = async (
    patch: Readonly<Record<string, unknown>>,
  ): Promise<AtomicWriteResult> => mutate((fresh) => {
    const primary = fresh.primary;
    if (!isRecord(primary)) throw new Error('Invalid LLM config: missing primary section');
    const nextPrimary: Record<string, unknown> = { ...primary };
    if (patch.entry_id !== undefined && !z.string().uuid().safeParse(patch.entry_id).success) {
      throw new LLMProviderEntryIdInvalidError();
    }
    for (const [key, value] of Object.entries(patch)) {
      // A field patch never replaces or deletes persistent resource identity.
      if (key === 'entry_id') continue;
      if (value === undefined) delete nextPrimary[key];
      else nextPrimary[key] = value;
    }
    if (typeof patch.preset === 'string' || typeof patch.provider_id === 'string') {
      // UX compatibility patches replace the identity as a unit; stale explicit
      // protocol/auth/hints must not leak across providers.
      for (const key of ['provider_id', 'api_format', 'auth_profile', 'catalog_provider', 'catalog_model']) {
        if (patch[key] === undefined || typeof patch.preset === 'string') delete nextPrimary[key];
      }
      if (typeof patch.preset === 'string') nextPrimary.preset = patch.preset;
      else nextPrimary.provider_id = patch.provider_id;
      return { ...fresh, primary: migrateLegacyProviderConfig(nextPrimary) } as LLMConfigDocument;
    }
    return { ...fresh, primary: nextPrimary } as LLMConfigDocument;
  });

  const commitExplicitProvider = async (
    target: LLMSetupCommitTarget,
    explicitConfig: ExplicitLLMProviderConfig,
    expectedRevision?: number,
  ): Promise<LLMConfigurationCommitResult> => {
    // Normal setup accepts only the explicit schema. Legacy presets must have
    // already crossed the explicit migration boundary; never resolve them here.
    // Persistent identity is allocated only by this store. New entries never
    // trust a copied caller ID; replacement reapplies the locked target ID below.
    const { entry_id: _explicitEntryId, ...explicitProviderFields } = explicitConfig;
    const provider = strictLLMProviderConfigSchema.parse(explicitProviderFields);
    // Replacement validates defaults but persists explicit raw fields.
    const rawProvider = target.kind === 'replace' ? explicitProviderFields : provider;
    if (target.kind === 'initialize') {
      if (expectedRevision !== undefined && expectedRevision !== 0) {
        throw new LLMConfigurationRevisionConflictError(expectedRevision, 0);
      }
      const initial = llmOrchestratorConfigSchema.parse({
        primary: provider,
        circuit_breaker: { failure_threshold: 3, reset_timeout_ms: 60_000 },
      });
      assertNormalDocumentLabels({
        ...initial, schema_version: DOCUMENT_SCHEMA_VERSION, revision: 1,
      } as LLMConfigDocument);
      let initialized: LLMConfigurationCommitResult | undefined;
      await withYamlConfigLock(deps, configPath, () => {
        try {
          const committedInitial = backfillMissingEntryIds(initial);
          writeYamlConfigExclusive(deps, configPath, {
            ...committedInitial,
            schema_version: DOCUMENT_SCHEMA_VERSION,
            revision: 1,
          });
          // Exclusive creation only fsyncs the file. Reuse the migration
          // target/parent barriers before claiming the initialize is durable.
          const write = confirmTargetDurability(
            'initialize',
            llmConfigurationSourceDigest(committedInitial),
          );
          initialized = {
            target,
            revision: { id: '1', revision: 1 },
            write,
            document: read(),
          };
        } catch (error) {
          if (isConfigStoreError(error) && error.code === 'already_exists') {
            throw new LLMConfigurationAlreadyExistsError(configPath, { cause: error });
          }
          throw error;
        }
      });
      return initialized!;
    }

    let committed: LLMConfigurationCommitResult | undefined;
    await withYamlConfigLock(deps, configPath, () => {
      const fresh = read();
      if (expectedRevision !== undefined && fresh.revision !== expectedRevision) {
        throw new LLMConfigurationRevisionConflictError(expectedRevision, fresh.revision);
      }
      if (target.kind === 'replace' && expectedRevision === undefined) {
        throw new Error('LLM provider replacement requires an expected revision');
      }
      if (target.kind === 'replace' && target.slot.role === 'fallback'
        && (!Number.isInteger(target.slot.index) || target.slot.index < 0
          || target.slot.index >= (fresh.fallbacks?.length ?? 0))) {
        throw new Error(`LLM provider target is unavailable: fallback[${target.slot.index}]`);
      }
      const label = rawProvider.label;
      const replacedIndex = target.kind === 'replace'
        ? target.slot.role === 'primary' ? 0 : target.slot.index + 1
        : -1;
      if (label !== undefined && [fresh.primary, ...(fresh.fallbacks ?? [])]
        .some((entry, index) => index !== replacedIndex && entry.label === label)) {
        throw new LLMProviderLabelAlreadyExistsError(label);
      }
      const current = documentConfig(fresh);
      const replacedProvider = target.kind === 'replace'
        ? providerAtSlot(fresh, target.slot)
        : undefined;
      const persistedProvider = replacedProvider?.entry_id !== undefined
        ? { ...rawProvider, entry_id: replacedProvider.entry_id }
        : rawProvider;
      let next: SharedLLMInput;
      if (target.kind === 'primary') {
        next = {
          ...current,
          primary: persistedProvider,
          fallbacks: [fresh.primary, ...(fresh.fallbacks ?? [])],
        };
      } else if (target.kind === 'fallback') {
        const position = target.position ?? (fresh.fallbacks?.length ?? 0);
        if (!Number.isInteger(position) || position < 0) {
          throw new Error(`Invalid fallback position: ${String(position)}`);
        }
        const fallbacks = [...(fresh.fallbacks ?? [])];
        fallbacks.splice(Math.min(position, fallbacks.length), 0, persistedProvider);
        next = { ...current, fallbacks };
      } else if (target.slot.role === 'primary') {
        next = { ...current, primary: persistedProvider };
      } else {
        if (!Number.isInteger(target.slot.index) || target.slot.index < 0
          || target.slot.index >= (fresh.fallbacks?.length ?? 0)) {
          throw new Error(`LLM provider target is unavailable: fallback[${target.slot.index}]`);
        }
        const fallbacks = [...(fresh.fallbacks ?? [])];
        fallbacks[target.slot.index] = persistedProvider;
        next = { ...current, fallbacks };
      }
      const validated = llmOrchestratorConfigSchema.parse(next);
      const committedConfig = backfillMissingEntryIds(target.kind === 'replace' ? next : validated);
      assertNormalDocumentLabels({
        ...committedConfig,
        schema_version: DOCUMENT_SCHEMA_VERSION,
        revision: fresh.revision,
      } as LLMConfigDocument);
      const revision = fresh.revision + 1;
      const write = writeYamlConfig(deps, configPath, {
        ...committedConfig,
        schema_version: DOCUMENT_SCHEMA_VERSION,
        revision,
      });
      committed = {
        target,
        revision: { id: String(revision), revision },
        write,
        document: read(),
      };
    });
    return committed!;
  };

  return {
    read,
    readResolved,
    readSnapshot,
    migrateLegacyApiKeys: (audit) => migrateLegacyApiKeysAtPath(deps, configPath, audit),
    migrateLegacyDocument,
    readRevision: () => {
      const document = read();
      return { id: String(document.revision), revision: document.revision };
    },
    mutate,
    assignMissingLabel,
    patchPrimary,
    commitExplicitProvider,
    createFromSource,
  };
}

export function createLLMConfiguration(deps: {
  fsFactory(baseDir: string): FileSystem;
}): LLMConfigurationAdmin {
  // CHESTNUT_ROOT 与磁盘内容均在调时解析；factory 不捕获工作区或配置快照。
  const store = () => createLLMConfigurationDocumentStore(deps);
  return {
    get store() { return store(); },
    loadGlobal: () => {
      const document = store().readSnapshot();
      const view = { llm: document.resolved };
      // 兼容既有调用方的对象形状；metadata 不可枚举但 snapshot 可同源消费。
      Object.defineProperties(view, {
        raw: { value: documentConfig(document.raw), enumerable: false },
        revision: {
          value: { id: String(document.resolved.revision), revision: document.resolved.revision },
          enumerable: false,
        },
        workspaceRoot: { value: getChestnutRoot(), enumerable: false },
        credentialSources: { value: document.credentialSources, enumerable: false },
        credentialFacts: { value: document.credentialFacts, enumerable: false },
      });
      return view;
    },
    loadRaw: () => {
      const document = store().read();
      return {
        llm: documentConfig(document),
        revision: { id: String(document.revision), revision: document.revision },
        workspaceRoot: getChestnutRoot(),
      };
    },
    loadSnapshot: () => {
      const document = store().readSnapshot();
      return {
        llm: document.resolved,
        raw: documentConfig(document.raw),
        revision: { id: String(document.resolved.revision), revision: document.resolved.revision },
        workspaceRoot: getChestnutRoot(),
        credentialSources: document.credentialSources,
        credentialFacts: document.credentialFacts,
      };
    },
    mutateGlobalLocked: (mutator) => store().mutate((fresh) => {
      const view = {
        llm: documentConfig(fresh),
        revision: { id: String(fresh.revision), revision: fresh.revision },
      };
      mutator(view);
      return { ...view.llm, schema_version: fresh.schema_version, revision: fresh.revision } as LLMConfigDocument;
    }),
    assignMissingLabel: (request) => store().assignMissingLabel(request),
    patchPrimary: (patch) => store().patchPrimary({ ...patch }),
    commitExplicitProvider: (target, explicitConfig, expectedRevision) =>
      store().commitExplicitProvider(target, explicitConfig, expectedRevision),
    migrateLegacyApiKeys: (audit) => store().migrateLegacyApiKeys(audit),
    migrateLegacyDocument: () => store().migrateLegacyDocument(),
    readRevision: () => store().readRevision(),
  };
}

/** 供调用方生成可重试且可关联证据的迁移 ID。 */
export function newLLMMigrationId(source: SharedLLMInput): string {
  return `root-${sha256Hex(llmConfigurationSourceDigest(source)).slice(0, 16)}-${newShortUuid()}`;
}

/** Assembly 清源后更新证据；目标写入未确认时不得调用。 */
export function recordLLMMigrationSourceCleanupFailure(
  deps: { fsFactory(baseDir: string): FileSystem },
  migrationId: string,
  error: unknown,
): void {
  const current = readLLMMigrationRecord(deps, migrationId);
  if (!current) return;
  writeYamlConfig(deps, getMigrationRecordPath(migrationId), {
    ...current,
    source_cleanup: 'failed',
    cleanup_error: formatErr(error).slice(0, 500),
  });
}

export function recordLLMMigrationSourceCleanup(
  deps: { fsFactory(baseDir: string): FileSystem },
  migrationId: string,
  result: AtomicWriteResult,
): void {
  const current = readLLMMigrationRecord(deps, migrationId);
  if (!current) throw new Error(`LLM migration evidence missing: ${migrationId}`);
  writeYamlConfig(deps, getMigrationRecordPath(migrationId), {
    ...current,
    source_cleanup: result.kind,
  });
}
