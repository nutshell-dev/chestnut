import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import {
  createLLMConfiguration,
  createLLMConfigurationDocumentStore,
  getLLMConfigurationPath,
  snapshotLLMConfig,
  LLMConfigurationMigrationError,
  LLMConfigurationAlreadyExistsError,
  LLMConfigurationRevisionConflictError,
  LLMProviderLabelAlreadyExistsError,
  llmConfigurationSourceDigest,
  migrateLegacyLLMConfig,
  LegacyPresetMigrationError,
  readLLMMigrationRecord,
  type SharedLLMInput,
} from '../../../src/core/llm-configuration/index.js';
import { createAuthenticationSetup } from '../../../src/core/llm-configuration/setup.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { cleanupTempDirSync, createTrackedTempDirSync } from '../../utils/temp.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });
const deps = { fsFactory };

let projectDir: string;

function referencedSource(): SharedLLMInput {
  return {
    primary: {
      provider_id: 'custom:anthropic',
      api_format: 'anthropic',
      auth_profile: 'api_key',
      api_key: '${LLM_DOCUMENT_TEST_KEY}',
      model: 'claude-document-test',
      label: 'primary-label',
      base_url: 'https://primary.example.test',
      extra_headers: { 'X-Test-Secret': '${LLM_DOCUMENT_TEST_HEADER}' },
    },
    fallbacks: [{
      provider_id: 'custom:openai',
      api_format: 'openai',
      auth_profile: 'api_key',
      api_key: '${LLM_DOCUMENT_TEST_KEY}',
      model: 'gpt-document-test',
      base_url: 'https://fallback.example.test/v1',
    }],
  };
}

function makeStore() {
  return createLLMConfigurationDocumentStore(deps);
}

beforeEach(() => {
  projectDir = createTrackedTempDirSync('chestnut-llm-document-project-');
  vi.stubEnv('CHESTNUT_ROOT', projectDir);
  vi.stubEnv('LLM_DOCUMENT_TEST_KEY', 'resolved-primary-secret');
  vi.stubEnv('LLM_DOCUMENT_TEST_HEADER', 'resolved-header-secret');
});

afterEach(() => {
  vi.unstubAllEnvs();
  cleanupTempDirSync(projectDir);
});

describe('LLM configuration document reads', () => {
  it('raw read 保留 ${REF}，且不物化 schema defaults 或写盘', () => {
    const store = makeStore();
    const source = referencedSource();
    store.createFromSource(source, 'test-seed');
    const before = fs.readFileSync(getLLMConfigurationPath(), 'utf8');

    const raw = store.read();

    expect(raw).toEqual({ ...source, schema_version: 1, revision: 1 });
    expect(raw.primary.api_key).toBe('${LLM_DOCUMENT_TEST_KEY}');
    expect(raw.primary.extra_headers).toEqual({ 'X-Test-Secret': '${LLM_DOCUMENT_TEST_HEADER}' });
    expect(raw.primary.temperature).toBeUndefined();
    expect(raw.retry_attempts).toBeUndefined();
    expect(fs.readFileSync(getLLMConfigurationPath(), 'utf8')).toBe(before);
  });

  it('loadGlobal/loadSnapshot 同源保留 raw ref、revision 与 scope，重建后身份一致', () => {
    makeStore().createFromSource(referencedSource(), 'test-seed');
    const firstAdmin = createLLMConfiguration(deps);
    const first = snapshotLLMConfig(firstAdmin.loadGlobal());
    expect(first.scope).toMatchObject({
      workspaceRoot: path.join(projectDir, '.chestnut'),
      workspaceRevision: 1,
      primarySource: 'workspace',
      documentSource: 'document',
    });
    expect(first.credentials).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'primary', ref: 'LLM_DOCUMENT_TEST_KEY', source: 'env' }),
      expect.objectContaining({ role: 'primary.extra_headers.X-Test-Secret', ref: 'LLM_DOCUMENT_TEST_HEADER', source: 'env' }),
    ]));
    const explicit = firstAdmin.loadSnapshot();
    expect(explicit.raw.primary.api_key).toBe('${LLM_DOCUMENT_TEST_KEY}');
    expect(explicit.revision.revision).toBe(1);
    expect(explicit.credentialFacts.LLM_DOCUMENT_TEST_KEY).toMatchObject({
      source: 'env', identityRef: 'LLM_DOCUMENT_TEST_KEY',
    });
    expect(explicit.credentialFacts.LLM_DOCUMENT_TEST_KEY?.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(explicit.credentialFacts)).not.toContain('resolved-primary-secret');
    expect(JSON.stringify(explicit.credentialFacts)).not.toContain('resolved-header-secret');

    vi.stubEnv('LLM_DOCUMENT_TEST_KEY', 'rotated-primary-secret');
    const restarted = snapshotLLMConfig(createLLMConfiguration(deps).loadGlobal());
    expect(restarted.identity).toBe(first.identity);
    expect(restarted.operationalIdentity).not.toBe(first.operationalIdentity);
    expect(restarted.credentialFacts.LLM_DOCUMENT_TEST_KEY?.revision)
      .not.toBe(first.credentialFacts.LLM_DOCUMENT_TEST_KEY?.revision);
    expect(restarted.credentials.find(entry => entry.role === 'primary')?.credentialRevision)
      .toBe(restarted.credentialFacts.LLM_DOCUMENT_TEST_KEY?.revision);
    expect(restarted.config.primary.authentication).toMatchObject({
      kind: 'api_key',
      value: 'rotated-primary-secret',
    });
  });

  it('workspace 文件轮换在 config revision 不变时产生新 credential fact 与 operational identity', async () => {
    vi.stubEnv('LLM_DOCUMENT_TEST_KEY', undefined);
    vi.stubEnv('LLM_DOCUMENT_TEST_HEADER', undefined);
    const setup = createAuthenticationSetup({ fsFactory, env: {} });
    await setup.set('LLM_DOCUMENT_TEST_KEY', 'file-secret-one');
    makeStore().createFromSource({
      primary: {
        preset: 'anthropic', api_key: '${LLM_DOCUMENT_TEST_KEY}', model: 'claude-document-test',
      },
    }, 'file-fact-seed');

    const first = createLLMConfiguration(deps).loadSnapshot();
    const firstSnapshot = snapshotLLMConfig(first);
    await setup.set('LLM_DOCUMENT_TEST_KEY', 'file-secret-two');
    const rotated = createLLMConfiguration(deps).loadSnapshot();
    const rotatedSnapshot = snapshotLLMConfig(rotated);

    expect(rotated.revision.revision).toBe(first.revision.revision);
    expect(rotated.credentialFacts.LLM_DOCUMENT_TEST_KEY).toMatchObject({
      source: 'file', identityRef: 'LLM_DOCUMENT_TEST_KEY',
    });
    expect(rotated.credentialFacts.LLM_DOCUMENT_TEST_KEY?.revision)
      .not.toBe(first.credentialFacts.LLM_DOCUMENT_TEST_KEY?.revision);
    expect(rotatedSnapshot.identity).toBe(firstSnapshot.identity);
    expect(rotatedSnapshot.operationalIdentity).not.toBe(firstSnapshot.operationalIdentity);
    const evidence = JSON.stringify({
      facts: rotated.credentialFacts,
      credentials: rotatedSnapshot.credentials,
      auth: rotatedSnapshot.auth,
      identity: rotatedSnapshot.identity,
    });
    expect(evidence).not.toContain('file-secret-one');
    expect(evidence).not.toContain('file-secret-two');
  });

  it('resolved read 展开引用并应用 defaults，raw 文档仍保留引用', () => {
    const store = makeStore();
    store.createFromSource(referencedSource(), 'test-seed');

    const resolved = store.readResolved();

    expect(resolved.primary.api_key).toBe('resolved-primary-secret');
    expect(resolved.primary.extra_headers).toEqual({ 'X-Test-Secret': 'resolved-header-secret' });
    expect(resolved.fallbacks?.[0]?.api_key).toBe('resolved-primary-secret');
    expect(resolved.primary.temperature).toBe(0.7);
    expect(resolved.retry_attempts).toEqual(expect.any(Number));
    expect(resolved).toMatchObject({ schema_version: 1, revision: 1 });
    expect(store.read().primary.api_key).toBe('${LLM_DOCUMENT_TEST_KEY}');
  });
});

describe('LLM configuration document mutations', () => {
  it('mutate 在锁内重读 fresh、递增 revision，合并且发更新且保留引用', async () => {
    const store = makeStore();
    store.createFromSource(referencedSource(), 'test-seed');
    const first = makeStore();
    const second = makeStore();
    const seenRevisions: number[] = [];

    await Promise.all([
      first.mutate(fresh => {
        seenRevisions.push(fresh.revision);
        return {
          ...fresh,
          revision: 100,
          primary: { ...fresh.primary, label: 'updated-by-first' },
        };
      }),
      second.mutate(fresh => {
        seenRevisions.push(fresh.revision);
        return {
          ...fresh,
          revision: 200,
          primary: { ...fresh.primary, model: 'updated-by-second' },
        };
      }),
    ]);

    expect(seenRevisions.sort((a, b) => a - b)).toEqual([1, 2]);
    expect(store.readRevision()).toEqual({ id: '3', revision: 3 });
    const document = store.read();
    expect(document.revision).toBe(3);
    expect(document.primary).toMatchObject({
      label: 'updated-by-first',
      model: 'updated-by-second',
      api_key: '${LLM_DOCUMENT_TEST_KEY}',
    });
    expect(document.fallbacks?.[0]?.api_key).toBe('${LLM_DOCUMENT_TEST_KEY}');
  });

  it('patchPrimary 将 undefined patch 值解释为删除键，其余 raw 字段不变', async () => {
    const store = makeStore();
    store.createFromSource(referencedSource(), 'test-seed');

    await store.patchPrimary({
      label: undefined,
      base_url: undefined,
      max_tokens: 4096,
    });

    const document = store.read();
    expect(document.revision).toBe(2);
    expect(document.primary).not.toHaveProperty('label');
    expect(document.primary).not.toHaveProperty('base_url');
    expect(document.primary).toMatchObject({
      api_key: '${LLM_DOCUMENT_TEST_KEY}',
      model: 'claude-document-test',
      max_tokens: 4096,
      extra_headers: { 'X-Test-Secret': '${LLM_DOCUMENT_TEST_HEADER}' },
    });
    expect(document.fallbacks).toEqual(referencedSource().fallbacks);
  });
});

describe('migrateLegacyDocument', () => {
  function writeRawDocument(source: unknown, revision: number, schemaVersion = 1): void {
    const configPath = getLLMConfigurationPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, yaml.dump({
      ...(source as Record<string, unknown>),
      schema_version: schemaVersion,
      revision,
    }));
  }

  function documentMigrationId(source: unknown): string {
    return `document-${llmConfigurationSourceDigest(source as SharedLLMInput).slice(0, 24)}`;
  }

  it('锁内迁移 preset/不完整 provider_id，revision+1 并重读核验；重试与显式文档均 no-op', async () => {
    const source = {
      primary: {
        preset: 'anthropic',
        model: 'claude-document-legacy',
        api_key: 'sk-document-migration-secret',
        extra_headers: { Authorization: 'Bearer document-header-secret' },
      },
      fallbacks: [{
        provider_id: 'amazon-bedrock',
        auth_profile: 'ambient',
        model: 'anthropic.claude-sonnet-4-6',
      }],
      retry_attempts: 2,
    };
    writeRawDocument(source, 7);
    const store = makeStore();

    const migrated = await store.migrateLegacyDocument();

    expect(migrated).toMatchObject({
      outcome: 'migrated',
      sourceRevision: 7,
      targetRevision: 8,
      write: { kind: 'durable' },
    });
    expect(store.read()).toMatchObject({
      schema_version: 1,
      revision: 8,
      primary: {
        provider_id: 'custom:anthropic',
        api_format: 'anthropic',
        auth_profile: 'api_key',
        api_key: 'sk-document-migration-secret',
      },
      fallbacks: [{
        provider_id: 'amazon-bedrock',
        api_format: 'bedrock-converse-stream',
        auth_profile: 'ambient',
      }],
    });
    expect(store.read().primary).not.toHaveProperty('preset');
    if (migrated.outcome !== 'migrated') throw new Error('expected migration');
    const evidence = readLLMMigrationRecord(deps, migrated.migrationId);
    expect(evidence).toMatchObject({
      outcome: 'migrated',
      source_revision: 7,
      target_revision: 8,
      source_digest: llmConfigurationSourceDigest(source as SharedLLMInput),
      target_digest: llmConfigurationSourceDigest(migrateLegacyLLMConfig(source).config),
      target_write: 'durable',
    });
    const evidencePath = path.join(
      projectDir, '.chestnut', 'llm', 'migration', `${migrated.migrationId}.yaml`,
    );
    const targetBefore = fs.readFileSync(getLLMConfigurationPath(), 'utf8');
    const evidenceBefore = fs.readFileSync(evidencePath, 'utf8');
    expect(evidenceBefore).not.toContain('sk-document-migration-secret');
    expect(evidenceBefore).not.toContain('document-header-secret');

    await expect(store.migrateLegacyDocument()).resolves.toEqual({ outcome: 'noop' });
    expect(fs.readFileSync(getLLMConfigurationPath(), 'utf8')).toBe(targetBefore);
    expect(fs.readFileSync(evidencePath, 'utf8')).toBe(evidenceBefore);
    expect(store.readRevision().revision).toBe(8);
  });

  it('覆盖前写 pending；目标已显式但成功证据缺失时按 digest/revision 补齐 migrated', async () => {
    const source = {
      primary: {
        preset: 'anthropic',
        model: 'claude-document-legacy',
        api_key: 'sk-pending-document-secret',
      },
    };
    writeRawDocument(source, 7);
    const id = documentMigrationId(source);
    const evidencePath = path.join(projectDir, '.chestnut', 'llm', 'migration', `${id}.yaml`);
    let pending: ReturnType<typeof readLLMMigrationRecord> = undefined;
    const crashingDeps = {
      fsFactory: (baseDir: string) => new (class extends NodeFileSystem {
        override writeAtomicSync(relativePath: string, content: string) {
          if (this.resolve(relativePath) === getLLMConfigurationPath()) {
            pending = readLLMMigrationRecord(deps, id);
          }
          if (this.resolve(relativePath) === evidencePath && content.includes('outcome: migrated')) {
            throw new Error('injected post-target crash');
          }
          return super.writeAtomicSync(relativePath, content);
        }
      })({ baseDir }),
    };

    await expect(createLLMConfigurationDocumentStore(crashingDeps).migrateLegacyDocument())
      .rejects.toThrow('injected post-target crash');
    expect(pending).toMatchObject({
      outcome: 'pending',
      source_digest: llmConfigurationSourceDigest(source as SharedLLMInput),
      target_digest: llmConfigurationSourceDigest(migrateLegacyLLMConfig(source).config),
      source_revision: 7,
      target_revision: 8,
      target_write: 'not_written',
    });
    expect(makeStore().read().revision).toBe(8);

    const recovered = await makeStore().migrateLegacyDocument();
    expect(recovered).toMatchObject({
      outcome: 'migrated',
      migrationId: id,
      sourceRevision: 7,
      targetRevision: 8,
      write: { kind: 'committed_durability_unknown' },
    });
    expect(readLLMMigrationRecord(deps, id)).toMatchObject({
      outcome: 'migrated',
      source_revision: 7,
      target_revision: 8,
      target_write: 'committed_durability_unknown',
    });
    expect(fs.readFileSync(evidencePath, 'utf8')).not.toContain('sk-pending-document-secret');
  });

  it('不存在的 shared 文档 no-op，不创建配置', async () => {
    await expect(makeStore().migrateLegacyDocument()).resolves.toEqual({ outcome: 'noop' });
    expect(fs.existsSync(getLLMConfigurationPath())).toBe(false);
  });

  it('未知 preset fail-closed，源 bytes/revision 不变且失败证据无 secret', async () => {
    const source = {
      primary: {
        preset: 'unknown-document-preset',
        model: 'secret-model-name',
        api_key: 'sk-unknown-document-secret',
        extra_headers: { 'X-Secret': 'unknown-header-secret' },
      },
    };
    writeRawDocument(source, 11);
    const before = fs.readFileSync(getLLMConfigurationPath(), 'utf8');

    await expect(makeStore().migrateLegacyDocument()).rejects.toBeInstanceOf(LegacyPresetMigrationError);

    expect(fs.readFileSync(getLLMConfigurationPath(), 'utf8')).toBe(before);
    expect(yaml.load(before)).toMatchObject({ revision: 11 });
    const id = documentMigrationId(source);
    expect(readLLMMigrationRecord(deps, id)).toMatchObject({
      outcome: 'failed',
      source_revision: 11,
      source_digest: llmConfigurationSourceDigest(source as SharedLLMInput),
      target_digest: '',
      target_write: 'not_written',
      migration_error: 'unknown_preset: primary',
    });
    const rawEvidence = fs.readFileSync(path.join(
      projectDir, '.chestnut', 'llm', 'migration', `${id}.yaml`,
    ), 'utf8');
    for (const sensitive of [
      'sk-unknown-document-secret',
      'unknown-header-secret',
      'secret-model-name',
      'unknown-document-preset',
    ]) {
      expect(rawEvidence).not.toContain(sensitive);
    }
  });

  it('损坏 metadata fail-closed，源不变并只记录安全错误分类', async () => {
    const source = {
      primary: {
        preset: 'anthropic',
        model: 'claude-document-legacy',
        api_key: 'sk-corrupt-document-secret',
      },
    };
    writeRawDocument(source, 9, 2);
    const before = fs.readFileSync(getLLMConfigurationPath(), 'utf8');

    await expect(makeStore().migrateLegacyDocument()).rejects.toThrow();

    expect(fs.readFileSync(getLLMConfigurationPath(), 'utf8')).toBe(before);
    const id = documentMigrationId(source);
    expect(readLLMMigrationRecord(deps, id)).toMatchObject({
      outcome: 'failed',
      source_revision: 9,
      target_write: 'not_written',
      migration_error: 'invalid_source: document',
    });
    expect(fs.readFileSync(path.join(
      projectDir, '.chestnut', 'llm', 'migration', `${id}.yaml`,
    ), 'utf8')).not.toContain('sk-corrupt-document-secret');
  });
});

describe('commitExplicitProvider', () => {
  function explicitProvider(label: string, model = label): SharedLLMInput['primary'] {
    return {
      provider_id: 'custom:anthropic',
      api_format: 'anthropic',
      auth_profile: 'api_key',
      api_key: '${LLM_DOCUMENT_TEST_KEY}',
      label,
      model,
      base_url: `https://${label}.example.test`,
    };
  }

  it('initialize 独占创建 rev1；primary 降级旧 primary，fallback 按 fresh position 插入并返回同源 snapshot', async () => {
    const store = makeStore();
    const initialized = await store.commitExplicitProvider({ kind: 'initialize' }, explicitProvider('first'));
    expect(initialized.revision).toEqual({ id: '1', revision: 1 });
    expect(initialized.write.kind).toBe('durable');
    expect(initialized.snapshot.raw).toMatchObject({ revision: 1, primary: { label: 'first' } });
    expect(initialized.snapshot.resolved.primary.api_key).toBe('resolved-primary-secret');

    await expect(store.commitExplicitProvider({ kind: 'initialize' }, explicitProvider('loser')))
      .rejects.toBeInstanceOf(LLMConfigurationAlreadyExistsError);
    expect(store.read().primary.label).toBe('first');

    const primary = await store.commitExplicitProvider({ kind: 'primary' }, explicitProvider('new-primary'), 1);
    expect(primary.revision.revision).toBe(2);
    expect(primary.snapshot.raw.fallbacks?.[0]?.label).toBe('first');

    const fallback = await store.commitExplicitProvider(
      { kind: 'fallback', position: 1 },
      explicitProvider('between'),
      2,
    );
    expect(fallback.revision.revision).toBe(3);
    expect(fallback.snapshot.raw.fallbacks?.map(entry => entry.label)).toEqual(['first', 'between']);
    expect(store.read().primary.label).toBe('new-primary');
  });

  it.each(['.initialize.target', '.initialize.llm-dir'])(
    'initialize 的 %s barrier 未确认时不伪报 durable，已提交文档仍可恢复',
    async (barrierSuffix) => {
      const uncertainDeps = {
        fsFactory: (baseDir: string) => new (class extends NodeFileSystem {
          override writeAtomicSync(relativePath: string, content: string) {
            if (this.resolve(relativePath).endsWith(barrierSuffix)) {
              return {
                kind: 'committed_durability_unknown' as const,
                error: Object.assign(new Error('injected initialize fsync uncertainty'), { code: 'EIO' }),
              };
            }
            return super.writeAtomicSync(relativePath, content);
          }
        })({ baseDir }),
      };
      const store = createLLMConfigurationDocumentStore(uncertainDeps);

      const result = await store.commitExplicitProvider(
        { kind: 'initialize' }, explicitProvider('durability'),
      );

      expect(result.write.kind).toBe('committed_durability_unknown');
      expect(store.read()).toMatchObject({ revision: 1, primary: { label: 'durability' } });
    },
  );

  it('锁内 label/CAS 失败不写盘；legacy preset 不能绕过显式提交边界', async () => {
    const store = makeStore();
    await store.commitExplicitProvider({ kind: 'initialize' }, explicitProvider('first'));
    const before = fs.readFileSync(getLLMConfigurationPath(), 'utf8');

    await expect(store.commitExplicitProvider({ kind: 'fallback' }, explicitProvider('first')))
      .rejects.toBeInstanceOf(LLMProviderLabelAlreadyExistsError);
    await expect(store.commitExplicitProvider({ kind: 'fallback' }, explicitProvider('other'), 99))
      .rejects.toBeInstanceOf(LLMConfigurationRevisionConflictError);
    await expect(store.commitExplicitProvider({ kind: 'fallback' }, {
      preset: 'anthropic', model: 'claude', api_key: '${LLM_DOCUMENT_TEST_KEY}',
    } as unknown as SharedLLMInput['primary'])).rejects.toThrow();

    expect(fs.readFileSync(getLLMConfigurationPath(), 'utf8')).toBe(before);
    expect(store.readRevision().revision).toBe(1);
  });
});

describe('createFromSource migration', () => {
  it('同 source 与 migration id 重试幂等，不重写目标或 revision', () => {
    const store = makeStore();
    const source = referencedSource();
    const migrationId = 'migration-idempotent';
    store.createFromSource(source, migrationId);
    const before = fs.readFileSync(getLLMConfigurationPath(), 'utf8');
    const firstEvidence = readLLMMigrationRecord(deps, migrationId);

    store.createFromSource(source, migrationId);

    expect(fs.readFileSync(getLLMConfigurationPath(), 'utf8')).toBe(before);
    expect(store.read()).toEqual({ ...source, schema_version: 1, revision: 1 });
    expect(readLLMMigrationRecord(deps, migrationId)).toEqual(firstEvidence);
    expect(firstEvidence).toMatchObject({
      source_digest: llmConfigurationSourceDigest(source),
      target_digest: llmConfigurationSourceDigest(source),
      source_cleanup: 'pending',
    });
  });

  it('source 与既有目标冲突时抛错且不覆盖目标', () => {
    const store = makeStore();
    const original = referencedSource();
    store.createFromSource(original, 'test-seed');
    const beforeDocument = store.read();
    const beforeBytes = fs.readFileSync(getLLMConfigurationPath(), 'utf8');
    const conflicting: SharedLLMInput = {
      ...original,
      primary: { ...original.primary, model: 'conflicting-model' },
    };

    expect(() => store.createFromSource(conflicting, 'migration-conflict'))
      .toThrowError(LLMConfigurationMigrationError);

    expect(store.read()).toEqual(beforeDocument);
    expect(fs.readFileSync(getLLMConfigurationPath(), 'utf8')).toBe(beforeBytes);
    expect(readLLMMigrationRecord(deps, 'migration-conflict')).toBeUndefined();
  });

  it('迁移证据只保存摘要与状态，不包含 key、header 秘密或引用名', () => {
    const store = makeStore();
    const source: SharedLLMInput = {
      primary: {
        preset: 'anthropic',
        api_key: 'sk-primary-migration-secret',
        model: 'claude-document-test',
        extra_headers: {
          Authorization: 'Bearer header-migration-secret',
          'X-Test-Secret': '${LLM_DOCUMENT_TEST_HEADER}',
        },
      },
      fallbacks: [{
        preset: 'openai',
        api_key: 'sk-fallback-migration-secret',
        model: 'gpt-document-test',
      }],
    };
    const migrationId = 'migration-evidence';

    store.createFromSource(source, migrationId);

    const digest = llmConfigurationSourceDigest(source);
    const targetDigest = llmConfigurationSourceDigest(migrateLegacyLLMConfig(source).config);
    const evidence = readLLMMigrationRecord(deps, migrationId);
    expect(evidence).toMatchObject({
      schema_version: 1,
      migration_id: migrationId,
      source_digest: digest,
      target_digest: targetDigest,
      target_revision: 1,
      preset_migration: true,
      source_cleanup: 'pending',
    });
    expect(Object.keys(evidence ?? {}).sort()).toEqual([
      'migration_id',
      'preset_migration',
      'schema_version',
      'source_cleanup',
      'source_digest',
      'target_digest',
      'target_revision',
      'target_write',
    ]);
    const evidencePath = path.join(
      projectDir, '.chestnut', 'llm', 'migration', `${migrationId}.yaml`,
    );
    const rawEvidence = fs.readFileSync(evidencePath, 'utf8');
    for (const sensitive of [
      'sk-primary-migration-secret',
      'sk-fallback-migration-secret',
      'header-migration-secret',
      'LLM_DOCUMENT_TEST_HEADER',
    ]) {
      expect(rawEvidence).not.toContain(sensitive);
    }
  });

  it('不完整 preset 映射同样不写目标并保留失败证据', () => {
    const store = makeStore();
    const source = {
      primary: { preset: 'custom-openai', model: 'model', api_key: 'sk-incomplete-secret' },
    } as unknown as SharedLLMInput;

    expect(() => store.createFromSource(source, 'migration-incomplete-preset'))
      .toThrow(LegacyPresetMigrationError);
    expect(fs.existsSync(getLLMConfigurationPath())).toBe(false);
    expect(readLLMMigrationRecord(deps, 'migration-incomplete-preset')).toMatchObject({
      target_write: 'not_written',
      migration_error: 'incomplete_mapping: primary',
    });
  });

  it('未知 preset 不写目标，typed error 与安全失败证据保留源摘要', () => {
    const store = makeStore();
    const source = {
      primary: { preset: 'unknown-preset', api_key: 'sk-must-not-leak' },
    } as unknown as SharedLLMInput;

    expect(() => store.createFromSource(source, 'migration-unknown-preset'))
      .toThrow(LegacyPresetMigrationError);
    expect(fs.existsSync(getLLMConfigurationPath())).toBe(false);
    const evidence = readLLMMigrationRecord(deps, 'migration-unknown-preset');
    expect(evidence).toMatchObject({
      source_digest: llmConfigurationSourceDigest(source),
      target_digest: '',
      target_write: 'not_written',
      migration_error: 'unknown_preset: primary',
    });
    const rawEvidence = fs.readFileSync(path.join(
      projectDir, '.chestnut', 'llm', 'migration', 'migration-unknown-preset.yaml',
    ), 'utf8');
    expect(rawEvidence).not.toContain('sk-must-not-leak');
  });
});
