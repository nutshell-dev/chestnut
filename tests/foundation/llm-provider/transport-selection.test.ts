/**
 * Phase 1925 Step C: transport 字段不再参与路由（pi-ai 唯一 L1 路径）。
 *
 * phase 1797 的 Anthropic transport 显式 discriminator 曾是 sdk/fetch 双 adapter
 * 路由依据；Step C 起 `createLLMProvider` 无条件路由 PiAiAdapter，transport 仅
 * 作为配置层残留字段透传（向后兼容既有 yaml），不再影响实现选择、不再触发
 * TRANSPORT_DEFAULTED audit。旧 adapter 与 transport 字段的删除属 Step D。
 */

import { describe, expect, it } from 'vitest';
import { createLLMProvider } from '../../../src/foundation/llm-provider/provider-factory.js';
import { PiAiAdapter } from '../../../src/foundation/llm-provider/pi-ai-adapter.js';
import { PRESETS } from '../../../src/foundation/llm-provider/presets.js';
import type { ProviderConfig, AuditSink } from '../../../src/foundation/llm-provider/types.js';
import { toProviderConfig } from '../../../src/foundation/llm-orchestrator/config-adapter.js';
import { llmProviderConfigSchema } from '../../../src/foundation/llm-orchestrator/llm-provider-config-schema.js';

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

function makeAuditSink(): { sink: AuditSink; events: Array<[string, ...string[]]> } {
  const events: Array<[string, ...string[]]> = [];
  return {
    sink: { write: (t: string, ...c: string[]) => { events.push([t, ...c]); }, preview: (s: string) => s },
    events,
  };
}

describe('pi-ai 单一路由（Phase 1925 Step C，取代 phase 1797 transport 双路由）', () => {
  it('transport=sdk/fetch/缺失 均路由 PiAiAdapter（实现与 model 名无关）', () => {
    expect(createLLMProvider(baseConfig({ transport: 'sdk', model: 'kimi-k2.5' }))).toBeInstanceOf(PiAiAdapter);
    expect(createLLMProvider(baseConfig({ transport: 'fetch', model: 'claude-3-7-sonnet-20250219' }))).toBeInstanceOf(PiAiAdapter);
    expect(createLLMProvider(baseConfig({ model: 'claude-3-7-sonnet-20250219' }))).toBeInstanceOf(PiAiAdapter);
  });

  it('openai/gemini apiFormat 同样路由 PiAiAdapter', () => {
    expect(createLLMProvider(baseConfig({ apiFormat: 'openai', model: 'gpt-4o' }))).toBeInstanceOf(PiAiAdapter);
    expect(createLLMProvider(baseConfig({ apiFormat: 'gemini', model: 'gemini-2.5-pro' }))).toBeInstanceOf(PiAiAdapter);
  });

  it('transport 缺失不再触发 TRANSPORT_DEFAULTED audit（无迁移默认概念）', () => {
    const { sink, events } = makeAuditSink();
    createLLMProvider(baseConfig({ model: 'claude-3-7-sonnet-20250219', auditLog: sink }));
    expect(events).toHaveLength(0);
  });

  it('端到端：preset kimi + model 改名含 claude → 仍 PiAiAdapter（无 audit 副作用）', () => {
    const { sink, events } = makeAuditSink();
    const cfg = toProviderConfig(llmProviderConfigSchema.parse({ preset: 'kimi', api_key: 'k', model: 'claude-lookalike' }));
    const p = createLLMProvider({ ...cfg, auditLog: sink });
    expect(p).toBeInstanceOf(PiAiAdapter);
    expect(events).toHaveLength(0);
  });

  // ── 配置层残留字段透传（Step D 删除前的向后兼容锁定） ──────────────────

  it('preset transport 默认值保留（配置层不变，仅路由层失效）', () => {
    expect(PRESETS['anthropic'].transport).toBe('sdk');
    expect(PRESETS['openrouter-anthropic'].transport).toBe('sdk');
    expect(PRESETS['kimi'].transport).toBe('fetch');
    expect(PRESETS['minimax'].transport).toBe('fetch');
    expect(PRESETS['zai'].transport).toBe('fetch');
    expect(PRESETS['custom-anthropic'].transport).toBeUndefined();
  });

  it('toProviderConfig 传播：preset 默认生效且 model 改名不影响 transport', () => {
    const base = llmProviderConfigSchema.parse({ preset: 'anthropic', api_key: 'k' });
    const a = toProviderConfig(base);
    expect(a.transport).toBe('sdk');
    const renamed = toProviderConfig(llmProviderConfigSchema.parse({ preset: 'anthropic', api_key: 'k', model: 'my-fine-tune-v1' }));
    expect(renamed.transport).toBe('sdk');
  });

  it('yaml 显式 transport 覆盖 preset 默认（字段透传但不改路由）', () => {
    const cfg = toProviderConfig(llmProviderConfigSchema.parse({ preset: 'anthropic', api_key: 'k', transport: 'fetch' }));
    expect(cfg.transport).toBe('fetch');
    expect(createLLMProvider({ ...cfg, auditLog: undefined })).toBeInstanceOf(PiAiAdapter);
  });
});
