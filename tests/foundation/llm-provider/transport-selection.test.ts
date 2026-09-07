/**
 * Phase 1797: Anthropic transport 显式 discriminator（model 名 heuristic 治理）。
 *
 * - transport 由显式配置决定：同一 transport 下任意 model 名称得到相同实现。
 * - 缺失 = 迁移默认 'fetch' + TRANSPORT_DEFAULTED audit（不按 model 名补全）。
 * - preset 单源默认对齐旧 heuristic；yaml 显式 transport 覆盖 preset。
 */

import { describe, expect, it } from 'vitest';
import { createLLMProvider } from '../../../src/foundation/llm-provider/provider-factory.js';
import { AnthropicAdapter } from '../../../src/foundation/llm-provider/anthropic.js';
import { CustomAnthropicAdapter } from '../../../src/foundation/llm-provider/custom-anthropic.js';
import { PRESETS } from '../../../src/foundation/llm-provider/presets.js';
import { LLM_PROVIDER_AUDIT_EVENTS } from '../../../src/foundation/llm-provider/audit-events.js';
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

describe('anthropic transport selection (phase 1797)', () => {
  it('model 独立性：transport=sdk 下无 claude 的 model 仍走 SDK adapter', () => {
    const p = createLLMProvider(baseConfig({ transport: 'sdk', model: 'kimi-k2.5' }));
    expect(p).toBeInstanceOf(AnthropicAdapter);
  });

  it('model 独立性：transport=fetch 下含 claude 的 model 仍走 raw-fetch adapter', () => {
    const p = createLLMProvider(baseConfig({ transport: 'fetch', model: 'claude-3-7-sonnet-20250219' }));
    expect(p).toBeInstanceOf(CustomAnthropicAdapter);
  });

  it('transport 缺失 → 迁移默认 fetch + TRANSPORT_DEFAULTED audit（不按 model 猜测）', () => {
    const { sink, events } = makeAuditSink();
    // 旧 heuristic 下含 claude 的 model 会走 SDK；现在必须落 fetch 并审计
    const p = createLLMProvider(baseConfig({ model: 'claude-3-7-sonnet-20250219', auditLog: sink }));
    expect(p).toBeInstanceOf(CustomAnthropicAdapter);
    expect(events).toHaveLength(1);
    expect(events[0][0]).toBe(LLM_PROVIDER_AUDIT_EVENTS.TRANSPORT_DEFAULTED);
    expect(events[0].join('\t')).toContain('provider=test-provider');
    expect(events[0].join('\t')).toContain('transport=fetch');
  });

  it('显式 transport → 无 TRANSPORT_DEFAULTED audit', () => {
    const { sink, events } = makeAuditSink();
    createLLMProvider(baseConfig({ transport: 'sdk', auditLog: sink }));
    expect(events.filter(e => e[0] === LLM_PROVIDER_AUDIT_EVENTS.TRANSPORT_DEFAULTED)).toHaveLength(0);
  });

  it('preset 单源默认对齐旧 heuristic', () => {
    expect(PRESETS['anthropic'].transport).toBe('sdk');
    expect(PRESETS['openrouter-anthropic'].transport).toBe('sdk');
    expect(PRESETS['kimi'].transport).toBe('fetch');
    expect(PRESETS['minimax'].transport).toBe('fetch');
    expect(PRESETS['zai'].transport).toBe('fetch');
    // custom-anthropic 无默认 model → 保留缺省走迁移审计路径
    expect(PRESETS['custom-anthropic'].transport).toBeUndefined();
  });

  it('toProviderConfig 传播：preset 默认生效且 model 改名不影响 transport', () => {
    const base = llmProviderConfigSchema.parse({ preset: 'anthropic', api_key: 'k' });
    const a = toProviderConfig(base);
    expect(a.transport).toBe('sdk');
    const renamed = toProviderConfig(llmProviderConfigSchema.parse({ preset: 'anthropic', api_key: 'k', model: 'my-fine-tune-v1' }));
    expect(renamed.transport).toBe('sdk');  // model 不含 claude 也不变
  });

  it('yaml 显式 transport 覆盖 preset 默认', () => {
    const cfg = toProviderConfig(llmProviderConfigSchema.parse({ preset: 'anthropic', api_key: 'k', transport: 'fetch' }));
    expect(cfg.transport).toBe('fetch');
    const p = createLLMProvider({ ...cfg, auditLog: undefined });
    expect(p).toBeInstanceOf(CustomAnthropicAdapter);
  });

  it('端到端：preset kimi + model 改名含 claude → 仍 raw-fetch（无 audit 副作用）', () => {
    const { sink, events } = makeAuditSink();
    const cfg = toProviderConfig(llmProviderConfigSchema.parse({ preset: 'kimi', api_key: 'k', model: 'claude-lookalike' }));
    const p = createLLMProvider({ ...cfg, auditLog: sink });
    expect(p).toBeInstanceOf(CustomAnthropicAdapter);
    expect(events).toHaveLength(0);  // preset 提供了显式默认 → 非迁移路径
  });
});
