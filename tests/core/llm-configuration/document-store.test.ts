import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  createLLMConfigurationDocumentStore,
  getLLMConfigurationPath,
  LLMConfigurationMigrationError,
  llmConfigurationSourceDigest,
  readLLMMigrationRecord,
  type SharedLLMInput,
} from '../../../src/core/llm-configuration/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { cleanupTempDirSync, createTrackedTempDirSync } from '../../utils/temp.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });
const deps = { fsFactory };

let homeDir: string;
let projectDir: string;

function referencedSource(): SharedLLMInput {
  return {
    primary: {
      preset: 'anthropic',
      api_key: '${LLM_DOCUMENT_TEST_KEY}',
      model: 'claude-document-test',
      label: 'primary-label',
      base_url: 'https://primary.example.test',
      extra_headers: { 'X-Test-Secret': '${LLM_DOCUMENT_TEST_HEADER}' },
    },
    fallbacks: [{
      preset: 'openai',
      api_key: '${LLM_DOCUMENT_TEST_KEY}',
      model: 'gpt-document-test',
    }],
  };
}

function makeStore() {
  return createLLMConfigurationDocumentStore(deps);
}

beforeEach(() => {
  homeDir = createTrackedTempDirSync('chestnut-llm-document-home-');
  projectDir = createTrackedTempDirSync('chestnut-llm-document-project-');
  vi.stubEnv('CHESTNUT_HOME', homeDir);
  vi.stubEnv('CHESTNUT_ROOT', projectDir);
  vi.stubEnv('LLM_DOCUMENT_TEST_KEY', 'resolved-primary-secret');
  vi.stubEnv('LLM_DOCUMENT_TEST_HEADER', 'resolved-header-secret');
});

afterEach(() => {
  vi.unstubAllEnvs();
  cleanupTempDirSync(homeDir);
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
    const evidence = readLLMMigrationRecord(deps, migrationId);
    expect(evidence).toMatchObject({
      schema_version: 1,
      migration_id: migrationId,
      source_digest: digest,
      target_digest: digest,
      source_cleanup: 'pending',
    });
    expect(Object.keys(evidence ?? {}).sort()).toEqual([
      'migration_id',
      'schema_version',
      'source_cleanup',
      'source_digest',
      'target_digest',
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
});
