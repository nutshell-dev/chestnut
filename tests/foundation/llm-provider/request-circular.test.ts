/**
 * Phase 1795: 循环引用请求 typed reason（循环误分类为 invalid_unicode 治理）。
 *
 * - active-path 重复访问 → reason 'circular_reference'，保留真实失败原因。
 * - 共享引用（diamond，非当前路径）不误判 —— seen WeakSet 访问后 delete。
 * - 异常后 fetch 次数为零（adapter 边界核证）。
 */

import { describe, expect, it, vi } from 'vitest';
import {
  LLMInvalidRequestError,
  serializeProviderRequest,
} from '../../../src/foundation/llm-provider/request-unicode.js';
import { OpenAIAdapter } from '../../../src/foundation/llm-provider/openai.js';

function catchInvalid(body: unknown, provider = 'openai'): LLMInvalidRequestError {
  try {
    serializeProviderRequest(provider, body);
  } catch (e) {
    expect(e).toBeInstanceOf(LLMInvalidRequestError);
    return e as LLMInvalidRequestError;
  }
  throw new Error('unreachable: serializeProviderRequest did not throw');
}

describe('circular_reference reason (phase 1795)', () => {
  it('自引用 → circular_reference + 保留循环路径', () => {
    const body: Record<string, unknown> = { a: 1 };
    body.self = body;
    const err = catchInvalid(body);
    expect(err.reason).toBe('circular_reference');
    expect(err.valuePath).toBe('$.self');
    expect(err.message).toBe('Invalid LLM request for openai: circular_reference');
  });

  it('嵌套回边 → circular_reference + 精确路径', () => {
    const a: Record<string, unknown> = { b: { c: {} } };
    (a.b as Record<string, Record<string, unknown>>).c.back = a;
    const err = catchInvalid(a, 'anthropic');
    expect(err.reason).toBe('circular_reference');
    expect(err.valuePath).toBe('$.b.c.back');
  });

  it('共享引用（diamond）不误判为循环', () => {
    const shared = { x: 'ok 中文' };
    const body = { p: shared, q: [shared, { r: shared }] };
    expect(serializeProviderRequest('openai', body)).toBe(JSON.stringify(body));
  });

  it('非法 Unicode 仍归 invalid_unicode（语义不变）', () => {
    const err = catchInvalid({ messages: [{ role: 'user', content: 'a\uD83Db' }] });
    expect(err.reason).toBe('invalid_unicode');
  });

  it('adapter 边界：循环 input_schema 拒绝且 fetch 为零', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      // formatTools 按引用传递 input_schema → 循环保留进 request body
      const cyclic: Record<string, unknown> = { type: 'object' };
      cyclic.self = cyclic;
      const adapter = new OpenAIAdapter({
        name: 'test-provider', apiKey: 'test-key', model: 'test-model',
        maxTokens: 1024, temperature: 0.5, timeoutMs: 30000, apiFormat: 'openai',
      });
      const tools = [{ name: 'write', description: 'd', input_schema: cyclic }];
      const err = await adapter.call({ messages: [{ role: 'user', content: 'hi' }], tools }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LLMInvalidRequestError);
      expect((err as LLMInvalidRequestError).reason).toBe('circular_reference');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
