import { describe, it, expect } from 'vitest';
import { llmProviderConfigSchema } from '../../../src/foundation/llm-provider/llm-provider-config-schema.js';
import { toProviderConfig } from '../../../src/foundation/llm-provider/config-adapter.js';

const explicitProvider = {
  provider_id: 'custom:openai',
  api_format: 'openai',
  auth_profile: 'api_key',
  api_key: '${OPENAI_API_KEY}',
  base_url: 'https://example.test/v1',
  model: 'some-model',
};

function parseProvider(input: Record<string, unknown>) {
  return toProviderConfig(llmProviderConfigSchema.parse(input));
}

describe('toProviderConfig explicit thinking fields', () => {
  it('does not inject provider, preset, or catalog thinking defaults', () => {
    const config = parseProvider(explicitProvider);
    expect(config.thinking).toBeUndefined();
    expect(config.thinkingMode).toBeUndefined();
    expect(config.thinkingEffort).toBeUndefined();
    expect(config.reasoningEffort).toBeUndefined();
    expect(config.dropThinkingBlocks).toBeUndefined();
  });

  it('projects every explicitly supplied field without a defaults package', () => {
    const config = parseProvider({
      ...explicitProvider,
      thinking: false,
      thinking_mode: 'enabled',
      thinking_effort: 'low',
      reasoning_effort: 'xhigh',
      thinking_budget_tokens: 4096,
      drop_thinking_blocks: true,
    });
    expect(config).toMatchObject({
      thinking: false,
      thinkingMode: 'enabled',
      thinkingEffort: 'low',
      reasoningEffort: 'xhigh',
      thinkingBudgetTokens: 4096,
      dropThinkingBlocks: true,
    });
  });

  it('accepts all supported effort levels and rejects unknown values', () => {
    for (const level of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
      expect(llmProviderConfigSchema.parse({ ...explicitProvider, thinking_effort: level }).thinking_effort).toBe(level);
      expect(llmProviderConfigSchema.parse({ ...explicitProvider, reasoning_effort: level }).reasoning_effort).toBe(level);
    }
    expect(() => llmProviderConfigSchema.parse({ ...explicitProvider, thinking_effort: 'ultra' })).toThrow();
  });
});
