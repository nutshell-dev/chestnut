/**
 * Phase 1926 Step D：pi-ai CredentialStore 桥接测试。
 *
 * 覆盖：ref 命名约定、read/modify/delete 全生命周期、modify 进程内串行化、
 * 损坏凭证 loud、未注册 backend 写路径 loud（read 视为无凭证不炸）。
 * backend 用内存 fake（L1 不知 Credentials owner；owner 适配器在 assembly 层）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createPiAiCredentialStore,
  piAiCredentialRef,
  registerPiAiCredentialBackend,
  type PiAiCredentialBackend,
} from '../../../src/foundation/llm-provider/pi-ai-credentials.js';
import { LLMError } from '../../../src/foundation/llm-provider/errors.js';

function fakeBackend(initial: Record<string, string> = {}): PiAiCredentialBackend & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    read: (ref) => Promise.resolve(data.get(ref)),
    write: (ref, value) => { data.set(ref, value); return Promise.resolve(); },
    remove: (ref) => { data.delete(ref); return Promise.resolve(); },
  };
}

beforeEach(() => {
  registerPiAiCredentialBackend(undefined);
});

describe('piAiCredentialRef', () => {
  it('环境变量命名约定（isCredentialRefName 合法）', () => {
    expect(piAiCredentialRef('openai-codex')).toBe('PI_AI_CREDENTIAL_OPENAI_CODEX');
    expect(piAiCredentialRef('amazon-bedrock')).toBe('PI_AI_CREDENTIAL_AMAZON_BEDROCK');
    expect(piAiCredentialRef('xai')).toBe('PI_AI_CREDENTIAL_XAI');
    for (const id of ['openai-codex', 'amazon-bedrock', 'google-vertex', 'kimi-coding']) {
      expect(piAiCredentialRef(id)).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
    }
  });
});

describe('createPiAiCredentialStore', () => {
  it('read：无 backend → undefined（视为无 stored credential，不炸）', async () => {
    const store = createPiAiCredentialStore();
    await expect(store.read('openai-codex')).resolves.toBeUndefined();
    await expect(store.list()).resolves.toEqual([]);
  });

  it('未注册 backend：modify/delete loud（OAuth 凭证不得静默丢失）', async () => {
    const store = createPiAiCredentialStore();
    await expect(store.modify('openai-codex', async () => ({ type: 'oauth', refresh: 'r', access: 'a', expires: 1 })))
      .rejects.toBeInstanceOf(LLMError);
    await expect(store.delete('openai-codex')).rejects.toBeInstanceOf(LLMError);
  });

  it('modify：读-改-写全周期 + JSON 持久化形状', async () => {
    const backend = fakeBackend();
    registerPiAiCredentialBackend(backend);
    const store = createPiAiCredentialStore();
    const written = await store.modify('openai-codex', async (current) => {
      expect(current).toBeUndefined();
      return { type: 'oauth', refresh: 'r0', access: 'a0', expires: 123 };
    });
    expect(written).toMatchObject({ refresh: 'r0' });
    const raw = backend.data.get('PI_AI_CREDENTIAL_OPENAI_CODEX');
    expect(raw).toBeDefined();
    expect(JSON.parse(raw!)).toMatchObject({ type: 'oauth', refresh: 'r0', access: 'a0' });
    // 回读同源
    await expect(store.read('openai-codex')).resolves.toMatchObject({ type: 'oauth', access: 'a0' });
    // fn 返回 undefined = 不变更
    const unchanged = await store.modify('openai-codex', async () => undefined);
    expect(unchanged).toBeUndefined();
    expect(JSON.parse(backend.data.get('PI_AI_CREDENTIAL_OPENAI_CODEX')!)).toMatchObject({ refresh: 'r0' });
  });

  it('modify 串行化：并发两写按链执行（OAuth refresh 锁纪律）', async () => {
    const backend = fakeBackend({
      PI_AI_CREDENTIAL_XAI: JSON.stringify({ type: 'oauth', refresh: 'r0', access: 'a0', expires: 1 }),
    });
    registerPiAiCredentialBackend(backend);
    const store = createPiAiCredentialStore();
    const order: string[] = [];
    const [r1, r2] = await Promise.all([
      store.modify('xai', async (cur) => {
        order.push(`first:${cur?.type}`);
        // 足够让并发的第二写进入等待队列即可（串行化证明不依赖时长）
        const MODIFY_RACE_WINDOW_MS = 10;
        await new Promise((res) => setTimeout(res, MODIFY_RACE_WINDOW_MS));
        return { type: 'oauth', refresh: 'r1', access: 'a1', expires: 2 };
      }),
      store.modify('xai', async (cur) => {
        // 第二写必须看到第一写的结果（串行读-改-写）
        order.push(`second:${(cur as { refresh?: string } | undefined)?.refresh}`);
        return { type: 'oauth', refresh: 'r2', access: 'a2', expires: 3 };
      }),
    ]);
    expect(order).toEqual(['first:oauth', 'second:r1']);
    expect(r2).toMatchObject({ refresh: 'r2' });
    expect(r1).toMatchObject({ refresh: 'r1' });
  });

  it('delete：移除 stored credential', async () => {
    const backend = fakeBackend({
      PI_AI_CREDENTIAL_XAI: JSON.stringify({ type: 'api_key', key: 'k' }),
    });
    registerPiAiCredentialBackend(backend);
    const store = createPiAiCredentialStore();
    await store.delete('xai');
    expect(backend.data.has('PI_AI_CREDENTIAL_XAI')).toBe(false);
    await expect(store.read('xai')).resolves.toBeUndefined();
  });

  it('list：按 catalog provider 集探测，只报元信息（不含 secret）', async () => {
    const backend = fakeBackend({
      PI_AI_CREDENTIAL_XAI: JSON.stringify({ type: 'oauth', refresh: 'r', access: 'a', expires: 1 }),
      PI_AI_CREDENTIAL_OPENAI: JSON.stringify({ type: 'api_key', key: 'sk-secret' }),
    });
    registerPiAiCredentialBackend(backend);
    const store = createPiAiCredentialStore();
    const infos = await store.list();
    expect(infos).toContainEqual({ providerId: 'xai', type: 'oauth' });
    expect(infos).toContainEqual({ providerId: 'openai', type: 'api_key' });
    expect(JSON.stringify(infos)).not.toContain('sk-secret');
    expect(JSON.stringify(infos)).not.toContain('"refresh"');
  });

  it('损坏凭证（非 JSON / 未知 type）→ loud LLMError（不静默当无凭证）', async () => {
    const backend = fakeBackend({
      PI_AI_CREDENTIAL_XAI: '{not json',
      PI_AI_CREDENTIAL_OPENAI: JSON.stringify({ type: 'weird' }),
    });
    registerPiAiCredentialBackend(backend);
    const store = createPiAiCredentialStore();
    await expect(store.read('xai')).rejects.toThrow(/corrupted/);
    await expect(store.read('openai')).rejects.toThrow(/unknown type/);
  });
});
