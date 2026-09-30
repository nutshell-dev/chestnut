/**
 * Phase 1926 Step D：pi-ai CredentialStore 桥接测试。
 * Phase 1927 Step E：边界重构——store 构造时固定注入 backend（无全局注册态）；
 * backend 接缝收窄为 read + modify（完整 RMW 事务由 owner 锁实现，见
 * tests/foundation/credentials/local-credentials.test.ts 的锁竞争用例）。
 *
 * 覆盖：ref 命名约定、read/modify/delete 全生命周期、modify 串行化、
 * 损坏凭证 loud、backend 生命周期内固定不漂移。
 * backend 用内存 fake（L1 不知 Credentials owner；owner 适配器在 assembly 层）。
 */
import { describe, it, expect } from 'vitest';
import {
  createPiAiCredentialStore,
  piAiCredentialRef,
  type PiAiCredentialBackend,
} from '../../../src/foundation/llm-provider/pi-ai-credentials.js';

/**
 * 内存 fake backend：modify 按实例串行链执行（模拟 owner 锁的串行化语义；
 * fn 返回 undefined = 删除）。
 */
function fakeBackend(initial: Record<string, string> = {}): PiAiCredentialBackend & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  let chain: Promise<unknown> = Promise.resolve();
  return {
    data,
    read: (ref) => Promise.resolve(data.get(ref)),
    modify: (ref, fn) => {
      const run = chain.then(async () => {
        const current = data.get(ref);
        const next = await fn(current);
        if (next === undefined) {
          data.delete(ref);
        } else if (next !== current) {
          data.set(ref, next);
        }
        return next;
      });
      // 错误由本次 modify 的调用方承载；串行链本身继续（后续 modify 不被前次失败卡死）
      chain = run.catch(() => { /* silent: 仅维持串行链不断，错误经 run 原样传播 */ });
      return run;
    },
  };
}

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
  it('read：ref 缺席 → undefined（视为无 stored credential，不炸）', async () => {
    const store = createPiAiCredentialStore(fakeBackend());
    await expect(store.read('openai-codex')).resolves.toBeUndefined();
    await expect(store.list()).resolves.toEqual([]);
  });

  it('modify：读-改-写全周期 + JSON 持久化形状；fn 返回 undefined = 不变更', async () => {
    const backend = fakeBackend();
    const store = createPiAiCredentialStore(backend);
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
    // pi-ai 契约：fn 返回 undefined = 不变更（删除只走 delete()），返回 post-write 当前值
    const unchanged = await store.modify('openai-codex', async () => undefined);
    expect(unchanged).toMatchObject({ refresh: 'r0' });
    expect(JSON.parse(backend.data.get('PI_AI_CREDENTIAL_OPENAI_CODEX')!)).toMatchObject({ refresh: 'r0' });
  });

  it('modify 串行化：并发两写按链执行（OAuth refresh 锁纪律）', async () => {
    const backend = fakeBackend({
      PI_AI_CREDENTIAL_XAI: JSON.stringify({ type: 'oauth', refresh: 'r0', access: 'a0', expires: 1 }),
    });
    const store = createPiAiCredentialStore(backend);
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
    const store = createPiAiCredentialStore(backend);
    await store.delete('xai');
    expect(backend.data.has('PI_AI_CREDENTIAL_XAI')).toBe(false);
    await expect(store.read('xai')).resolves.toBeUndefined();
  });

  it('list：按 catalog provider 集探测，只报元信息（不含 secret）', async () => {
    const backend = fakeBackend({
      PI_AI_CREDENTIAL_XAI: JSON.stringify({ type: 'oauth', refresh: 'r', access: 'a', expires: 1 }),
      PI_AI_CREDENTIAL_OPENAI: JSON.stringify({ type: 'api_key', key: 'sk-secret' }),
    });
    const store = createPiAiCredentialStore(backend);
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
    const store = createPiAiCredentialStore(backend);
    await expect(store.read('xai')).rejects.toThrow(/corrupted/);
    await expect(store.read('openai')).rejects.toThrow(/unknown type/);
  });

  it('backend 在 store 生命周期内固定：两个 store 各自独立、互不漂移', async () => {
    // Phase 1927 Step E 反向：无全局可替换 backend——每个 store 只认构造时注入的实例
    const backendA = fakeBackend({
      PI_AI_CREDENTIAL_XAI: JSON.stringify({ type: 'api_key', key: 'key-a' }),
    });
    const backendB = fakeBackend({
      PI_AI_CREDENTIAL_XAI: JSON.stringify({ type: 'api_key', key: 'key-b' }),
    });
    const storeA = createPiAiCredentialStore(backendA);
    const storeB = createPiAiCredentialStore(backendB);
    await expect(storeA.read('xai')).resolves.toMatchObject({ key: 'key-a' });
    await expect(storeB.read('xai')).resolves.toMatchObject({ key: 'key-b' });
    // storeA 的写不泄漏到 backendB（无共享全局态）
    await storeA.modify('xai', async () => ({ type: 'api_key', key: 'key-a2' }));
    await expect(storeB.read('xai')).resolves.toMatchObject({ key: 'key-b' });
  });
});
