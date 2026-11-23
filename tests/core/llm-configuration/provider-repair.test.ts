import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import {
  createLLMConfigurationDocumentStore,
  getLLMConfigurationPath,
  LLMConfigurationCredentialUnavailableError,
  LLMConfigurationRevisionConflictError,
  LLMProviderLabelAlreadyExistsError,
  snapshotLLMProviderDraft,
  snapshotLLMProviderTarget,
  CredentialsError,
  type SharedLLMInput,
} from '../../../src/core/llm-configuration/index.js';
import { createAuthenticationSetup } from '../../../src/core/llm-configuration/setup.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { cleanupTempDirSync, createTrackedTempDirSync } from '../../utils/temp.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });
const deps = { fsFactory };
let projectDir: string;

function provider(label: string, key = '${PHASE2221_TARGET_KEY}'): SharedLLMInput['primary'] {
  return {
    provider_id: 'custom:anthropic',
    api_format: 'anthropic',
    auth_profile: 'api_key',
    api_key: key,
    model: `${label}-model`,
    label,
    base_url: 'https://target.example.test',
    extra_headers: { 'X-Target': '${PHASE2221_HEADER_KEY}' },
  };
}

beforeEach(() => {
  projectDir = createTrackedTempDirSync('chestnut-provider-repair-');
  vi.stubEnv('CHESTNUT_ROOT', projectDir);
  vi.stubEnv('PHASE2221_TARGET_KEY', 'target-secret');
  vi.stubEnv('PHASE2221_HEADER_KEY', 'header-secret');
  vi.stubEnv('PHASE2221_MISSING_KEY', undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  cleanupTempDirSync(projectDir);
});

describe('single-provider credential resolution', () => {
  it('只解析选中目标及 header，其他 provider 缺 ref 不阻断', async () => {
    const store = createLLMConfigurationDocumentStore(deps);
    await store.commitExplicitProvider({ kind: 'initialize' }, provider('primary'));
    await store.commitExplicitProvider(
      { kind: 'fallback' },
      { ...provider('broken', '${PHASE2221_MISSING_KEY}'), extra_headers: undefined },
    );

    const resolved = snapshotLLMProviderTarget(deps, store.read(), { role: 'primary' });
    expect(resolved.snapshot.config.primary.model).toBe('primary-model');
    expect(resolved.snapshot.config.primary.authentication).toMatchObject({ value: 'target-secret' });
    expect(resolved.snapshot.credentialFacts).toHaveProperty('PHASE2221_HEADER_KEY');
    expect(() => store.readSnapshot()).toThrow(LLMConfigurationCredentialUnavailableError);
  });

  it('missing 与空环境值产生 typed failure，保留 ref 且不包含 secret', () => {
    for (const value of [undefined, '']) {
      vi.stubEnv('PHASE2221_MISSING_KEY', value);
      let thrown: unknown;
      try {
        snapshotLLMProviderDraft(deps, provider('missing', '${PHASE2221_MISSING_KEY}'));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(LLMConfigurationCredentialUnavailableError);
      expect((thrown as LLMConfigurationCredentialUnavailableError).ref).toBe('PHASE2221_MISSING_KEY');
      expect(String(thrown)).not.toContain('target-secret');
    }
  });

  it('credential 权限错误不转换成 missing', async () => {
    vi.stubEnv('PHASE2221_TARGET_KEY', undefined);
    const authentication = createAuthenticationSetup(deps);
    await authentication.set('PHASE2221_TARGET_KEY', 'file-secret');
    const credentialsPath = `${projectDir}/.chestnut/llm/credentials.yaml`;
    fs.chmodSync(credentialsPath, 0o644);

    expect(() => snapshotLLMProviderDraft(deps, {
      ...provider('permissions'), extra_headers: undefined,
    })).toThrow(CredentialsError);
    try {
      snapshotLLMProviderDraft(deps, { ...provider('permissions'), extra_headers: undefined });
    } catch (error) {
      expect(error).toMatchObject({ code: 'permissions' });
      expect(error).not.toBeInstanceOf(LLMConfigurationCredentialUnavailableError);
    }
  });

  it('同 ref 的 credential 值变化改变 operational identity', () => {
    const first = snapshotLLMProviderDraft(deps, provider('rotation'));
    vi.stubEnv('PHASE2221_TARGET_KEY', 'rotated-secret');
    const rotated = snapshotLLMProviderDraft(deps, provider('rotation'));
    expect(rotated.snapshot.identity).toBe(first.snapshot.identity);
    expect(rotated.snapshot.operationalIdentity).not.toBe(first.snapshot.operationalIdentity);
  });
});

describe('in-place provider replacement', () => {
  it('primary/fallback 原 slot 替换，保留其他条目与未显式声明的 raw 字段', async () => {
    const store = createLLMConfigurationDocumentStore(deps);
    await store.commitExplicitProvider({ kind: 'initialize' }, provider('primary'));
    await store.commitExplicitProvider({ kind: 'fallback' }, provider('fallback'));
    const before = store.read();

    const primary = await store.commitExplicitProvider(
      { kind: 'replace', slot: { role: 'primary' } },
      { ...before.primary, api_key: '${PHASE2221_TARGET_KEY}', temperature: undefined },
      before.revision,
    );
    expect(primary.document.primary.label).toBe('primary');
    expect(primary.document.primary).not.toHaveProperty('temperature');
    expect(primary.document.fallbacks).toEqual(before.fallbacks);

    const fallback = await store.commitExplicitProvider(
      { kind: 'replace', slot: { role: 'fallback', index: 0 } },
      { ...before.fallbacks![0]!, model: 'fallback-repaired' },
      primary.revision.revision,
    );
    expect(fallback.document.primary).toEqual(primary.document.primary);
    expect(fallback.document.fallbacks?.[0]?.model).toBe('fallback-repaired');
    expect(fallback.document.fallbacks).toHaveLength(1);
  });

  it('同 label 自替换允许，其他条目重名拒绝', async () => {
    const store = createLLMConfigurationDocumentStore(deps);
    await store.commitExplicitProvider({ kind: 'initialize' }, provider('same'));
    await store.commitExplicitProvider({ kind: 'fallback' }, provider('other'));
    const current = store.read();
    await expect(store.commitExplicitProvider(
      { kind: 'replace', slot: { role: 'primary' } }, current.primary, current.revision,
    )).resolves.toMatchObject({ revision: { revision: 3 } });
    await expect(store.commitExplicitProvider(
      { kind: 'replace', slot: { role: 'primary' } },
      { ...current.primary, label: 'other' }, 3,
    )).rejects.toBeInstanceOf(LLMProviderLabelAlreadyExistsError);
    expect(store.readRevision().revision).toBe(3);
  });

  it('revision 漂移、目标消失和缺失 expectedRevision 均零写入', async () => {
    const store = createLLMConfigurationDocumentStore(deps);
    await store.commitExplicitProvider({ kind: 'initialize' }, provider('primary'));
    const before = fs.readFileSync(getLLMConfigurationPath(), 'utf8');
    const current = store.read();

    await expect(store.commitExplicitProvider(
      { kind: 'replace', slot: { role: 'primary' } }, current.primary, 99,
    )).rejects.toBeInstanceOf(LLMConfigurationRevisionConflictError);
    await expect(store.commitExplicitProvider(
      { kind: 'replace', slot: { role: 'fallback', index: 0 } }, current.primary, 1,
    )).rejects.toThrow('target is unavailable');
    await expect(store.commitExplicitProvider(
      { kind: 'replace', slot: { role: 'primary' } }, current.primary,
    )).rejects.toThrow('requires an expected revision');
    expect(fs.readFileSync(getLLMConfigurationPath(), 'utf8')).toBe(before);
  });
});
