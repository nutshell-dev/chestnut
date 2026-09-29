/**
 * Phase 1926 Step C：LLM 配置快照身份协议测试。
 *
 * - llmConfigIdentity：同源派生稳定性、字段敏感性、secret 摘要化（不明文入身份）；
 * - verifyExpectedLLMIdentity（daemon 装配前复核）：缺省不检查、相等放行、
 *   不等 typed invalidation（LLMConfigIdentityMismatchError，携非 secret 摘要）。
 */

import { describe, it, expect } from 'vitest';
import {
  snapshotLLMConfig,
  llmConfigIdentity,
  resolveLLMConfig,
  LLMConfigIdentityMismatchError,
} from '../../src/assembly/index.js';
import { verifyExpectedLLMIdentity } from '../../src/daemon/daemon.js';

function makeGlobal(model: string, apiKey = '${ANTHROPIC_API_KEY}') {
  return {
    llm: {
      primary: {
        preset: 'anthropic',
        api_key: apiKey,
        model,
        temperature: 0.7,
        timeout_ms: 30000,
      },
      retry_attempts: 2,
      retry_delay_ms: 1000,
    },
  } as unknown as Parameters<typeof snapshotLLMConfig>[0];
}

describe('llmConfigIdentity / snapshotLLMConfig (Phase 1926 Step C)', () => {
  it('同一配置恒得同一身份；任一业务字段变化身份必变', () => {
    const a = snapshotLLMConfig(makeGlobal('claude-x'));
    const a2 = snapshotLLMConfig(makeGlobal('claude-x'));
    const b = snapshotLLMConfig(makeGlobal('claude-y'));

    expect(a.identity).toBe(a2.identity);
    expect(a.identity).not.toBe(b.identity);
    expect(a.identity).toMatch(/^[0-9a-f]{64}$/);
  });

  it('api_key 变化身份必变，且 identity 不含明文 secret', () => {
    const secret = 'sk-ant-real-secret-value-12345';
    const withKey = snapshotLLMConfig(makeGlobal('claude-x', secret));
    const otherKey = snapshotLLMConfig(makeGlobal('claude-x', 'sk-ant-other-value'));

    expect(withKey.identity).not.toBe(otherKey.identity);
    expect(withKey.identity).not.toContain(secret);
  });

  it('identity 由 resolved config 派生（model=auto 解析为 preset 默认模型）', () => {
    const autoSnap = snapshotLLMConfig(makeGlobal('auto'));
    const resolved = resolveLLMConfig(makeGlobal('auto'));
    expect(autoSnap.identity).toBe(llmConfigIdentity(resolved));
    expect(autoSnap.config.primary.model).not.toBe('auto');
  });
});

describe('verifyExpectedLLMIdentity (daemon 装配前复核)', () => {
  it('expected 缺省（watchdog 重启等无身份 spawn）→ 不检查', () => {
    expect(() => verifyExpectedLLMIdentity(makeGlobal('claude-x'), undefined)).not.toThrow();
  });

  it('身份相等 → 放行', () => {
    const global = makeGlobal('claude-x');
    const expected = snapshotLLMConfig(global).identity;
    expect(() => verifyExpectedLLMIdentity(global, expected)).not.toThrow();
  });

  it('身份不等 → typed invalidation（含非 secret 摘要、不含明文 key）', () => {
    const expected = snapshotLLMConfig(makeGlobal('model-A')).identity;
    const err = (() => {
      try {
        verifyExpectedLLMIdentity(makeGlobal('model-B'), expected);
        return undefined;
      } catch (e) {
        return e;
      }
    })();

    expect(err).toBeInstanceOf(LLMConfigIdentityMismatchError);
    const mismatch = err as LLMConfigIdentityMismatchError;
    expect(mismatch.expected).toBe(expected);
    expect(mismatch.actual).toBe(snapshotLLMConfig(makeGlobal('model-B')).identity);
    expect(mismatch.message).toContain(expected.slice(0, 12));
    expect(mismatch.message).not.toContain('ANTHROPIC_API_KEY');
  });
});
