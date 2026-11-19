import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createAuthenticationCapability } from '../../../src/core/llm-configuration/index.js';
import { createAuthenticationSetup } from '../../../src/core/llm-configuration/setup.js';
import { llmProviderCredentialRuntime } from '../../../src/foundation/llm-provider/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createTrackedTempDirSync } from '../../utils/temp.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

beforeEach(() => {
  vi.stubEnv('CHESTNUT_HOME', createTrackedTempDirSync('chestnut-auth-store-'));
  vi.stubEnv('CHESTNUT_ROOT', createTrackedTempDirSync('chestnut-auth-project-'));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createAuthenticationCapability', () => {
  it('异步解析 accessToken，并保留非 secret describe provenance', async () => {
    const setup = createAuthenticationSetup({ fsFactory, env: {} });
    await setup.set('PRIMARY_KEY', 'secret-one');
    const authentication = createAuthenticationCapability({ fsFactory, env: {} });

    await expect(authentication.resolve('PRIMARY_KEY')).resolves.toEqual({ accessToken: 'secret-one' });
    expect(authentication.describe('PRIMARY_KEY')).toEqual({
      identityRef: 'PRIMARY_KEY',
      identityVersion: 1,
      configured: true,
      writable: true,
      source: 'file',
    });
    expect(authentication.describe('MISSING_KEY')).toMatchObject({
      identityRef: 'MISSING_KEY', configured: false, writable: true,
    });
    await expect(authentication.resolve('MISSING_KEY')).rejects.toMatchObject({
      code: 'credential_unavailable', ref: 'MISSING_KEY',
    });
  });

  it('普通 capability 不暴露 setup 写面', () => {
    const authentication = createAuthenticationCapability({ fsFactory, env: {} });
    expect(authentication).not.toHaveProperty('set');
    expect(authentication).not.toHaveProperty('unset');
    expect(authentication).not.toHaveProperty('read');
    expect(authentication).not.toHaveProperty('modify');
  });
});

describe('createAuthenticationSetup + L1 createStore', () => {
  it('固定使用兼容用户级后端，read/modify 复用同一凭据文件', async () => {
    const setup = createAuthenticationSetup({ fsFactory, env: {} });
    const store = llmProviderCredentialRuntime.createStore(setup);
    await store.modify('xai', async (current) => {
      expect(current).toBeUndefined();
      return { type: 'oauth', refresh: 'refresh-one', access: 'access-one', expires: 1 };
    });

    await expect(store.read('xai')).resolves.toMatchObject({ refresh: 'refresh-one' });
    expect(JSON.parse(setup.resolveSync('PI_AI_CREDENTIAL_XAI')!.accessToken)).toMatchObject({
      type: 'oauth',
      refresh: 'refresh-one',
    });
  });

  it('跨组合共享已提交值，既有 store 不被后续构造重新绑定', async () => {
    const first = llmProviderCredentialRuntime.createStore(
      createAuthenticationSetup({ fsFactory, env: {} }),
    );
    await first.modify('xai', async () => ({ type: 'api_key', key: 'first-key' }));

    const second = llmProviderCredentialRuntime.createStore(
      createAuthenticationSetup({ fsFactory, env: {} }),
    );
    await expect(second.read('xai')).resolves.toMatchObject({ key: 'first-key' });
    await second.modify('xai', async (current) => {
      expect(current).toMatchObject({ key: 'first-key' });
      return { type: 'api_key', key: 'second-key' };
    });

    await expect(first.read('xai')).resolves.toMatchObject({ key: 'second-key' });
  });
});
