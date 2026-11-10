import { describe, it, expect, vi } from 'vitest';
import {
  deriveCredentialRef,
  isCredentialReference,
  resolveCredentialReference,
  storeCredentialInput,
  CredentialsError,
  type CredentialSource,
  type CredentialsOwner,
} from '../../../src/core/llm-configuration/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';

function fakeOwner(overrides: Partial<CredentialsOwner> = {}): CredentialsOwner {
  return {
    resolve: vi.fn(() => undefined),
    describe: vi.fn(() => ({ configured: false, writable: true })),
    set: vi.fn(async () => {}),
    unset: vi.fn(async () => {}),
    modify: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('credential key input recognition', () => {
  it('识别完整引用并派生兼容 ref 名', () => {
    expect(isCredentialReference(' ${ANTHROPIC_API_KEY} ')).toBe(true);
    expect(isCredentialReference('prefix-${KEY}')).toBe(false);
    expect(deriveCredentialRef('anthropic')).toBe('CHESTNUT_ANTHROPIC_API_KEY');
    expect(deriveCredentialRef(' 123-a/b ')).toBe('CHESTNUT_123_A_B_API_KEY');
    expect(deriveCredentialRef('---')).toBe('CHESTNUT_PRIMARY_API_KEY');
  });

  it('解析引用，legacy 明文保持原值', () => {
    const deps = {
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
      env: { TEST_KEY: 'resolved-secret' },
    };
    expect(resolveCredentialReference(deps, '${TEST_KEY}')).toBe('resolved-secret');
    expect(resolveCredentialReference(deps, '${MISSING_KEY}')).toBeUndefined();
    expect(resolveCredentialReference(deps, 'legacy-plaintext')).toBe('legacy-plaintext');
  });
});

describe('storeCredentialInput', () => {
  it('原样引用不写凭据', async () => {
    const owner = fakeOwner();
    await expect(storeCredentialInput(owner, ' ${EXISTING_REF} ', 'NEW_REF', 'fallback'))
      .resolves.toEqual({ kind: 'reference', reference: '${EXISTING_REF}' });
    expect(owner.set).not.toHaveBeenCalled();
    expect(owner.resolve).not.toHaveBeenCalled();
  });

  it('新明文存储后返回 reference 与 created=true', async () => {
    const owner = fakeOwner();
    await expect(storeCredentialInput(owner, ' sk-new ', 'NEW_REF', 'fallback')).resolves.toEqual({
      kind: 'stored', reference: '${NEW_REF}', ref: 'NEW_REF', created: true,
    });
    expect(owner.set).toHaveBeenCalledWith('NEW_REF', 'sk-new');
  });

  it.each<CredentialSource>(['env', 'file', 'project-env', 'user-env'])(
    '四层来源均计入已存在：%s → created=false',
    async (source) => {
      const owner = fakeOwner({ resolve: vi.fn(() => ({ value: 'existing', source })) });
      await expect(storeCredentialInput(owner, 'replacement', 'EXISTING_REF', 'fallback'))
        .resolves.toMatchObject({ kind: 'stored', created: false });
    },
  );

  it('fallback 环境遮蔽不写文件并返回 environment', async () => {
    const owner = fakeOwner({
      resolve: vi.fn(() => ({ value: 'ambient', source: 'env' as const })),
      set: vi.fn(async () => { throw new CredentialsError('shadowed_by_env', 'shadowed'); }),
    });
    await expect(storeCredentialInput(owner, 'typed', 'AMBIENT_REF', 'fallback')).resolves.toEqual({
      kind: 'environment', reference: '${AMBIENT_REF}', ref: 'AMBIENT_REF',
    });
  });

  it('error 模式保留 shadowed_by_env typed 错误', async () => {
    const shadowed = new CredentialsError('shadowed_by_env', 'shadowed');
    const owner = fakeOwner({ set: vi.fn(async () => { throw shadowed; }) });
    await expect(storeCredentialInput(owner, 'typed', 'AMBIENT_REF', 'error'))
      .rejects.toBe(shadowed);
  });

  it('其他存储失败原样传播', async () => {
    const failure = new CredentialsError('io_error', 'disk failed');
    const owner = fakeOwner({ set: vi.fn(async () => { throw failure; }) });
    await expect(storeCredentialInput(owner, 'typed', 'NEW_REF', 'fallback'))
      .rejects.toBe(failure);
  });
});
