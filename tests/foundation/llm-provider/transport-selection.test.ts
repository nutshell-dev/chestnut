/**
 * Phase 1925 Step D: pi-ai 单一路由不变量（原 phase 1797 transport 选择测试）。
 *
 * phase 1797 的 transport 显式 discriminator 与其配置字段已随旧 adapter 删除；
 * 本文件只保留路由层不变量：`createLLMProvider` 对全部 apiFormat/model 无条件
 * 路由 PiAiAdapter，无 transport 概念、无 TRANSPORT_DEFAULTED audit。
 */

import { describe, expect, it } from 'vitest';
import { createLLMProvider } from '../../../src/foundation/llm-provider/provider-factory.js';
import { PiAiAdapter } from '../../../src/foundation/llm-provider/pi-ai-adapter.js';
import type { ProviderConfig, AuditSink } from '../../../src/foundation/llm-provider/types.js';

function baseConfig(overrides: Partial<ProviderConfig>): ProviderConfig {
  return {
    name: 'test-provider',
    apiKey: 'test-key',
    model: 'test-model',
    temperature: 0.5,
    timeoutMs: 30000,
    apiFormat: 'anthropic',
    ...overrides,
  };
}

describe('pi-ai 单一路由（Phase 1925 Step C/D，取代 phase 1797 transport 双路由）', () => {
  it('全部 apiFormat/model 组合路由 PiAiAdapter（实现与 model 名无关）', () => {
    expect(createLLMProvider(baseConfig({ model: 'kimi-k2.5' }))).toBeInstanceOf(PiAiAdapter);
    expect(createLLMProvider(baseConfig({ model: 'claude-3-7-sonnet-20250219' }))).toBeInstanceOf(PiAiAdapter);
    expect(createLLMProvider(baseConfig({ apiFormat: 'openai', model: 'gpt-4o' }))).toBeInstanceOf(PiAiAdapter);
    expect(createLLMProvider(baseConfig({ apiFormat: 'gemini', model: 'gemini-2.5-pro' }))).toBeInstanceOf(PiAiAdapter);
  });

  it('factory 不写任何 audit（无迁移默认概念）', () => {
    const events: Array<[string, ...string[]]> = [];
    const sink: AuditSink = { write: (t: string, ...c: string[]) => { events.push([t, ...c]); }, preview: (s: string) => s };
    createLLMProvider(baseConfig({ model: 'claude-3-7-sonnet-20250219', auditLog: sink }));
    expect(events).toHaveLength(0);
  });
});
