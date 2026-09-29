/**
 * Phase 1926 Step D：config schema api_key 可选 + toProviderConfig auth profile 透传。
 *
 * ambient（AWS 链/ADC/provider env）与 OAuth preset 不在 yaml 持 key——schema 放行；
 * api_key preset 的必填约束由 CLI 交互/缺参判定保证（provider-factory 装配期仍校验）。
 */
import { describe, it, expect } from 'vitest';
import { llmProviderConfigSchema } from '../../../src/foundation/llm-orchestrator/llm-provider-config-schema.js';
import { toProviderConfig } from '../../../src/foundation/llm-orchestrator/config-adapter.js';
import { UnknownPresetError } from '../../../src/foundation/llm-provider/presets.js';

describe('llmProviderConfigSchema — api_key 可选（Phase 1926 Step D）', () => {
  it('无 api_key 的 provider 配置通过 schema（ambient/oauth 形状）', () => {
    const parsed = llmProviderConfigSchema.parse({
      preset: 'amazon-bedrock',
      model: 'anthropic.claude-sonnet-4-6',
    });
    expect(parsed.api_key).toBeUndefined();
  });

  it('空字符串 api_key 仍拒绝（min(1) 语义不变）', () => {
    expect(() => llmProviderConfigSchema.parse({ preset: 'anthropic', api_key: '' }))
      .toThrow(/api_key must not be empty/);
  });
});

describe('toProviderConfig — auth profile 透传', () => {
  it('ambient preset：apiKey/apiFormat 缺席、authProfile=ambient、piAiProvider 透传', () => {
    const config = toProviderConfig(llmProviderConfigSchema.parse({
      preset: 'amazon-bedrock',
      model: 'auto',
    }));
    expect(config.apiKey).toBeUndefined();
    expect(config.apiFormat).toBeUndefined();
    expect(config.authProfile).toBe('ambient');
    expect(config.piAiProvider).toBe('amazon-bedrock');
    expect(config.model).toBe('anthropic.claude-sonnet-4-6');
  });

  it('oauth preset：authProfile=oauth、defaultModel 解析', () => {
    const config = toProviderConfig(llmProviderConfigSchema.parse({ preset: 'openai-codex' }));
    expect(config.authProfile).toBe('oauth');
    expect(config.apiKey).toBeUndefined();
    expect(config.model).toBe('gpt-5.5');
  });

  it('api_key preset：形状不变（apiFormat 必填、authProfile undefined=api_key 语义）', () => {
    const config = toProviderConfig(llmProviderConfigSchema.parse({
      preset: 'anthropic',
      api_key: 'sk-x',
    }));
    expect(config.apiKey).toBe('sk-x');
    expect(config.apiFormat).toBe('anthropic');
    expect(config.authProfile).toBeUndefined();
  });

  it('unknown preset 仍抛 UnknownPresetError', () => {
    expect(() => toProviderConfig(llmProviderConfigSchema.parse({
      preset: 'not-a-preset',
    }))).toThrow(UnknownPresetError);
  });
});
