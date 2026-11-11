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
import {
  llmOrchestratorConfigSchema,
} from '../../foundation/llm-orchestrator/index.js';
import { formatErr, newShortUuid, sha256Hex } from '../../foundation/node-utils/index.js';
import { createLocalCredentials, isCredentialsError } from './legacy-credentials/index.js';
import type { SharedLLM, SharedLLMInput } from './selection.js';

const DOCUMENT_SCHEMA_VERSION = 1 as const;
const documentMetadataSchema = z.object({
  schema_version: z.literal(DOCUMENT_SCHEMA_VERSION),
  revision: z.number().int().positive(),
});
const resolvedDocumentSchema = llmOrchestratorConfigSchema.extend({
  schema_version: z.literal(DOCUMENT_SCHEMA_VERSION),
  revision: z.number().int().positive(),
});

export type LLMConfigDocument = SharedLLMInput & z.infer<typeof documentMetadataSchema>;
export type ResolvedLLMConfigDocument = SharedLLM & z.infer<typeof documentMetadataSchema>;
export type LLMConfigurationWriteResult = AtomicWriteResult;

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
  readRevision(): LLMConfigurationRevision;
  /** 锁内重读 raw 文档；调用方返回完整新文档，revision 由 store 单调推进。 */
  mutate(
    fn: (fresh: LLMConfigDocument) => LLMConfigDocument,
  ): Promise<LLMConfigurationWriteResult>;
  patchPrimary(patch: Readonly<Record<string, unknown>>): Promise<LLMConfigurationWriteResult>;
  /** Assembly 兼容保存入口；新管理命令应使用带锁 mutate。 */
  save(source: SharedLLMInput): LLMConfigurationWriteResult;
  /** 独占创建或核验同内容目标；在确认前不得清理迁移源。 */
  createFromSource(
    source: SharedLLMInput,
    migrationId: string,
  ): LLMConfigurationWriteResult;
}

export interface LLMConfigurationAdmin {
  loadGlobal(): { llm: SharedLLM };
  /** 配置与 revision 同次磁盘读取，禁止把旧配置登记成新 revision。 */
  loadSnapshot(): { llm: SharedLLM; revision: LLMConfigurationRevision };
  mutateGlobalLocked(
    mutator: (config: { llm: SharedLLM }) => void,
  ): Promise<LLMConfigurationWriteResult>;
  patchPrimary(patch: Readonly<Record<string, unknown>>): Promise<LLMConfigurationWriteResult>;
  readRevision(): LLMConfigurationRevision;
  readonly store: LLMConfigurationDocumentStore;
}

export class LLMConfigurationNotFoundError extends Error {
  constructor(readonly configPath: string) {
    super(`LLM configuration not found: ${configPath}`);
    this.name = 'LLMConfigurationNotFoundError';
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
  target_write: AtomicWriteResult['kind'];
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

function parseRawDocument(value: unknown, configPath: string): LLMConfigDocument {
  if (!isRecord(value)) {
    throw new Error(`Invalid LLM configuration document: expected object: ${configPath}`);
  }
  const metadata = documentMetadataSchema.parse(value);
  const { schema_version: _schemaVersion, revision: _revision, ...config } = value;
  // 校验但不回写 parse 结果，避免 mutation 将 defaults 物化或展开引用。
  llmOrchestratorConfigSchema.parse(config);
  return { ...config, ...metadata } as LLMConfigDocument;
}

function makeEnvVarResolver(deps: { fsFactory(baseDir: string): FileSystem }) {
  const credentials = createLocalCredentials({ fsFactory: deps.fsFactory });
  return (name: string): string | undefined => {
    try {
      return credentials.resolve(name)?.value;
    } catch (error) {
      if (isCredentialsError(error) && error.code === 'invalid_ref') return process.env[name];
      throw error;
    }
  };
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

  const readResolved = (): ResolvedLLMConfigDocument => {
    try {
      return loadYamlConfig<ResolvedLLMConfigDocument>(
        { fsFactory: deps.fsFactory, resolveEnvVar: makeEnvVarResolver(deps) },
        configPath,
        resolvedDocumentSchema,
      );
    } catch (error) {
      if (isConfigStoreError(error) && error.code === 'not_found') {
        throw new LLMConfigurationNotFoundError(configPath);
      }
      throw error;
    }
  };

  const writeMigrationRecord = (record: MigrationRecord): AtomicWriteResult =>
    writeYamlConfig(deps, getMigrationRecordPath(record.migration_id), record);

  const createFromSource = (
    source: SharedLLMInput,
    migrationId: string,
  ): AtomicWriteResult => {
    const sourceDigest = llmConfigurationSourceDigest(source);
    const sourceConfig = llmOrchestratorConfigSchema.parse(source);
    // 写回原始 source（含 `${REF}`），parse 仅用于校验，避免秘密/默认值改写。
    void sourceConfig;
    if (!configExists(deps, configPath)) {
      try {
        writeYamlConfigExclusive(deps, configPath, {
          ...source,
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
    if (targetDigest !== sourceDigest) {
      throw new LLMConfigurationMigrationError(
        `LLM migration source/target conflict; neither document was cleared or overwritten: ${migrationId}`,
        migrationId,
      );
    }

    // writeExclusiveSync 只 fsync 文件，不证明目录项持久。两个 barrier 分别
    // fsync .chestnut/llm（目标文件名）与 .chestnut（新建 llm 目录项）；
    // 任一未确认都返回非 durable，由 Assembly 保留 root.llm。
    const targetBarrier = writeYamlConfig(
      deps,
      path.join(getChestnutRoot(), 'llm', `.${migrationId}.target`),
      { migration_id: migrationId, target_digest: targetDigest },
    );
    const parentBarrier = targetBarrier.kind === 'durable'
      ? writeYamlConfig(
        deps,
        path.join(getChestnutRoot(), `.${migrationId}.llm-dir`),
        { migration_id: migrationId },
      )
      : targetBarrier;
    const confirmedBarrier = parentBarrier.kind === 'durable' ? targetBarrier : parentBarrier;
    const confirmation = writeMigrationRecord({
      schema_version: 1,
      migration_id: migrationId,
      source_digest: sourceDigest,
      target_digest: targetDigest,
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
      result = writeYamlConfig(deps, configPath, {
        ...nextConfig,
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

  const save = (source: SharedLLMInput): AtomicWriteResult => {
    llmOrchestratorConfigSchema.parse(source);
    const revision = configExists(deps, configPath) ? read().revision + 1 : 1;
    return writeYamlConfig(deps, configPath, {
      ...source,
      schema_version: DOCUMENT_SCHEMA_VERSION,
      revision,
    });
  };

  const patchPrimary = async (
    patch: Readonly<Record<string, unknown>>,
  ): Promise<AtomicWriteResult> => mutate((fresh) => {
    const primary = fresh.primary;
    if (!isRecord(primary)) throw new Error('Invalid LLM config: missing primary section');
    const nextPrimary: Record<string, unknown> = { ...primary };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete nextPrimary[key];
      else nextPrimary[key] = value;
    }
    return { ...fresh, primary: nextPrimary } as LLMConfigDocument;
  });

  return {
    read,
    readResolved,
    readRevision: () => {
      const document = read();
      return { id: String(document.revision), revision: document.revision };
    },
    mutate,
    patchPrimary,
    save,
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
    loadGlobal: () => ({ llm: store().readResolved() }),
    loadSnapshot: () => {
      const document = store().readResolved();
      return {
        llm: document,
        revision: { id: String(document.revision), revision: document.revision },
      };
    },
    mutateGlobalLocked: (mutator) => store().mutate((fresh) => {
      const view = { llm: documentConfig(fresh) as SharedLLM };
      mutator(view);
      return { ...view.llm, schema_version: fresh.schema_version, revision: fresh.revision } as LLMConfigDocument;
    }),
    patchPrimary: (patch) => store().patchPrimary({ ...patch }),
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
