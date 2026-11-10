import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createLegacyAuthenticationStore,
  createLocalCredentials,
} from '../../../src/core/llm-configuration/index.js';
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

describe('createLegacyAuthenticationStore', () => {
  it('固定使用兼容用户级后端，read/modify 复用同一凭据文件', async () => {
    const store = createLegacyAuthenticationStore({ fsFactory, env: {} });
    await store.modify('xai', async (current) => {
      expect(current).toBeUndefined();
      return { type: 'oauth', refresh: 'refresh-one', access: 'access-one', expires: 1 };
    });

    await expect(store.read('xai')).resolves.toMatchObject({ refresh: 'refresh-one' });
    const owner = createLocalCredentials({ fsFactory, env: {} });
    expect(JSON.parse(owner.resolve('PI_AI_CREDENTIAL_XAI')!.value)).toMatchObject({
      type: 'oauth',
      refresh: 'refresh-one',
    });
  });

  it('跨工厂调用共享已提交值，既有 store 不被后续构造重新绑定', async () => {
    const first = createLegacyAuthenticationStore({ fsFactory, env: {} });
    await first.modify('xai', async () => ({ type: 'api_key', key: 'first-key' }));

    const second = createLegacyAuthenticationStore({ fsFactory, env: {} });
    await expect(second.read('xai')).resolves.toMatchObject({ key: 'first-key' });
    await second.modify('xai', async (current) => {
      expect(current).toMatchObject({ key: 'first-key' });
      return { type: 'api_key', key: 'second-key' };
    });

    await expect(first.read('xai')).resolves.toMatchObject({ key: 'second-key' });
  });
});
