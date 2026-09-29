/**
 * Phase 1926 Step D：pi-ai 原生 auth 装配行为测试（getAuth 面，零 wire）。
 *
 * 经 createPiAiEndpoint（catalog 命中 → builtin provider + CredentialStore 桥）
 * + 注入 AuthContext（env/fileExists 全 fake，不触进程环境与真实文件系统），
 * 逐 auth 类断言 pi-ai 原生解析语义：
 * - api_key：config override 排他优先 > stored credential > provider env；
 * - ambient：AWS 链（access keys / profile / ECS / web identity）与 Google ADC
 *   缺失 → undefined（unconfigured），存在 → AuthResult（source 标签）；
 * - oauth：stored credential 有效 → toAuth；过期 → 锁内 refresh 并持久化轮换
 *   凭证；refresh 失败 → ModelsError 且旧凭证保留（不静默回退 env）。
 * 另有一条请求面映射：unconfigured → LLMAuthError（不得吞成 unknown/network）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type * as PiAi from '@earendil-works/pi-ai';
import { createPiAiEndpoint } from '../../../src/foundation/llm-provider/pi-ai-support.js';
import { registerPiAiCredentialBackend, type PiAiCredentialBackend } from '../../../src/foundation/llm-provider/pi-ai-credentials.js';
import { createLLMProvider } from '../../../src/foundation/llm-provider/provider-factory.js';
import { LLMAuthError } from '../../../src/foundation/llm-provider/errors.js';
import type { ProviderConfig } from '../../../src/foundation/llm-provider/types.js';

function fakeBackend(initial: Record<string, string> = {}): PiAiCredentialBackend & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    read: (ref) => Promise.resolve(data.get(ref)),
    write: (ref, value) => { data.set(ref, value); return Promise.resolve(); },
    remove: (ref) => { data.delete(ref); return Promise.resolve(); },
  };
}

function fakeAuthContext(env: Record<string, string> = {}, files: string[] = []): PiAi.AuthContext {
  return {
    env: (name) => Promise.resolve(env[name]),
    fileExists: (p) => Promise.resolve(files.includes(p)),
  };
}

function catalogConfig(overrides: Partial<ProviderConfig>): ProviderConfig {
  return {
    name: 'test',
    model: 'gpt-4o',
    temperature: 0.7,
    timeoutMs: 60_000,
    ...overrides,
  };
}

beforeEach(() => {
  registerPiAiCredentialBackend(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api_key 类：override > stored > env（pi-ai 原生优先级）', () => {
  it('无 override / stored / env → unconfigured（undefined）', async () => {
    const ep = await createPiAiEndpoint(
      catalogConfig({ piAiProvider: 'openai', model: 'gpt-4o' }),
      { authContext: fakeAuthContext() },
    );
    await expect(ep.models.getAuth(ep.model)).resolves.toBeUndefined();
  });

  it('provider env（OPENAI_API_KEY）→ AuthResult', async () => {
    const ep = await createPiAiEndpoint(
      catalogConfig({ piAiProvider: 'openai', model: 'gpt-4o' }),
      { authContext: fakeAuthContext({ OPENAI_API_KEY: 'sk-env' }) },
    );
    const auth = await ep.models.getAuth(ep.model);
    expect(auth?.auth.apiKey).toBe('sk-env');
  });

  it('stored credential 优先于 env；config.apiKey override 排他优先于两者', async () => {
    registerPiAiCredentialBackend(fakeBackend({
      PI_AI_CREDENTIAL_OPENAI: JSON.stringify({ type: 'api_key', key: 'sk-stored' }),
    }));
    const ep = await createPiAiEndpoint(
      catalogConfig({ piAiProvider: 'openai', model: 'gpt-4o' }),
      { authContext: fakeAuthContext({ OPENAI_API_KEY: 'sk-env' }) },
    );
    const stored = await ep.models.getAuth(ep.model);
    expect(stored?.auth.apiKey).toBe('sk-stored');
    const override = await ep.models.getAuth(ep.model, { apiKey: 'sk-override' });
    expect(override?.auth.apiKey).toBe('sk-override');
  });
});

describe('ambient 类：AWS 链 / Google ADC（无 stored credential 的环境解析）', () => {
  it('bedrock：空环境 → unconfigured', async () => {
    const ep = await createPiAiEndpoint(
      catalogConfig({ piAiProvider: 'amazon-bedrock', model: 'anthropic.claude-sonnet-4-6', authProfile: 'ambient' }),
      { authContext: fakeAuthContext() },
    );
    await expect(ep.models.getAuth(ep.model)).resolves.toBeUndefined();
  });

  it('bedrock：AWS access keys → AuthResult（source 标签可见）', async () => {
    const ep = await createPiAiEndpoint(
      catalogConfig({ piAiProvider: 'amazon-bedrock', model: 'anthropic.claude-sonnet-4-6', authProfile: 'ambient' }),
      { authContext: fakeAuthContext({ AWS_ACCESS_KEY_ID: 'AKIA...', AWS_SECRET_ACCESS_KEY: 'secret' }) },
    );
    const auth = await ep.models.getAuth(ep.model);
    expect(auth).toBeDefined();
    expect(auth?.source).toBe('AWS access keys');
  });

  it('bedrock：AWS_PROFILE → AuthResult', async () => {
    const ep = await createPiAiEndpoint(
      catalogConfig({ piAiProvider: 'amazon-bedrock', model: 'anthropic.claude-sonnet-4-6', authProfile: 'ambient' }),
      { authContext: fakeAuthContext({ AWS_PROFILE: 'prod' }) },
    );
    const auth = await ep.models.getAuth(ep.model);
    expect(auth?.source).toBe('AWS_PROFILE');
  });

  it('vertex：GOOGLE_CLOUD_API_KEY → AuthResult；空环境 + 无 ADC 文件 → unconfigured', async () => {
    const withKey = await createPiAiEndpoint(
      catalogConfig({ piAiProvider: 'google-vertex', model: 'gemini-2.5-pro', authProfile: 'ambient' }),
      { authContext: fakeAuthContext({ GOOGLE_CLOUD_API_KEY: 'gcp-key', GOOGLE_CLOUD_PROJECT: 'p', GOOGLE_CLOUD_LOCATION: 'l' }) },
    );
    const auth = await withKey.models.getAuth(withKey.model);
    expect(auth?.auth.apiKey).toBe('gcp-key');

    const without = await createPiAiEndpoint(
      catalogConfig({ piAiProvider: 'google-vertex', model: 'gemini-2.5-pro', authProfile: 'ambient' }),
      { authContext: fakeAuthContext() },
    );
    await expect(without.models.getAuth(without.model)).resolves.toBeUndefined();
  });
});

describe('oauth 类：stored credential 生命周期（toAuth / refresh / 持久化）', () => {
  const codexConfig = () => catalogConfig({
    name: 'codex',
    piAiProvider: 'openai-codex',
    model: 'gpt-5.5',
    authProfile: 'oauth',
  });

  function fakeJwt(accountId: string): string {
    const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    return `${b64({ alg: 'none' })}.${b64({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })}.sig`;
  }

  it('无 stored credential → unconfigured', async () => {
    const ep = await createPiAiEndpoint(codexConfig(), { authContext: fakeAuthContext() });
    await expect(ep.models.getAuth(ep.model)).resolves.toBeUndefined();
  });

  it('stored credential 有效（未临期）→ toAuth 直接派生请求 auth', async () => {
    registerPiAiCredentialBackend(fakeBackend({
      PI_AI_CREDENTIAL_OPENAI_CODEX: JSON.stringify({
        type: 'oauth', refresh: 'r0', access: 'a0', expires: Date.now() + 3_600_000, accountId: 'acct-1',
      }),
    }));
    const ep = await createPiAiEndpoint(codexConfig(), { authContext: fakeAuthContext() });
    const auth = await ep.models.getAuth(ep.model);
    expect(auth?.auth.apiKey).toBe('a0');
  });

  it('stored credential 过期 → 锁内 refresh + 轮换凭证持久化回 backend', async () => {
    const backend = fakeBackend({
      PI_AI_CREDENTIAL_OPENAI_CODEX: JSON.stringify({
        type: 'oauth', refresh: 'r0', access: 'a0', expires: 1000, accountId: 'acct-1',
      }),
    });
    registerPiAiCredentialBackend(backend);
    const newAccess = fakeJwt('acct-1');
    const fetchMock = vi.fn().mockImplementation((input: unknown) => {
      const url = String(input);
      if (url.includes('auth.openai.com')) {
        return Promise.resolve(new Response(JSON.stringify({
          access_token: newAccess,
          refresh_token: 'r1',
          expires_in: 3600,
        }), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      return Promise.resolve(new Response('unexpected', { status: 500 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const ep = await createPiAiEndpoint(codexConfig(), { authContext: fakeAuthContext() });
    const auth = await ep.models.getAuth(ep.model);
    expect(auth?.auth.apiKey).toBe(newAccess);
    // 轮换凭证已持久化（refresh token 同步轮换）
    const persisted = JSON.parse(backend.data.get('PI_AI_CREDENTIAL_OPENAI_CODEX')!);
    expect(persisted).toMatchObject({ type: 'oauth', refresh: 'r1', access: newAccess, accountId: 'acct-1' });
  });

  it('refresh 失败（invalid_grant）→ 拒绝且旧凭证保留（不静默回退 env）', async () => {
    const backend = fakeBackend({
      PI_AI_CREDENTIAL_OPENAI_CODEX: JSON.stringify({
        type: 'oauth', refresh: 'r0', access: 'a0', expires: 1000, accountId: 'acct-1',
      }),
    });
    registerPiAiCredentialBackend(backend);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
    ));
    const ep = await createPiAiEndpoint(codexConfig(), { authContext: fakeAuthContext() });
    await expect(ep.models.getAuth(ep.model)).rejects.toThrow(/refresh/i);
    // 旧凭证未被清除（用户 re-login 修复；不得静默丢凭证）
    expect(backend.data.has('PI_AI_CREDENTIAL_OPENAI_CODEX')).toBe(true);
  });

  it('请求面：unconfigured → LLMAuthError（不吞成 unknown/network）', async () => {
    const adapter = createLLMProvider(codexConfig());
    await expect(adapter.call({ messages: [{ role: 'user', content: 'hi' }] }))
      .rejects.toBeInstanceOf(LLMAuthError);
  });
});
