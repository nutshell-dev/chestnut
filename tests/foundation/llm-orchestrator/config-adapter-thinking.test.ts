/**
 * Phase 1979: toProviderConfig 的 preset thinking 默认填充。
 *
 * - 配置未显式给出任何 thinking 字段 → preset 默认；
 * - 任一显式字段（含 thinking:false）整体优先，不混入 preset 默认；
 * - provider_id（catalog-only）路径不填 preset 默认；
 * - schema 接受全档 effort（minimal..max）。
 */
import { describe, it, expect } from 'vitest';
import { llmProviderConfigSchema } from '../../../src/foundation/llm-orchestrator/llm-provider-config-schema.js';
import { toProviderConfig } from '../../../src/foundation/llm-orchestrator/config-adapter.js';

function parseProvider(input: Record<string, unknown>) {
  return toProviderConfig(llmProviderConfigSchema.parse(input));
}

describe('toProviderConfig preset thinking defaults', () => {
  it('minimax：无显式字段 → adaptive/max + dropThinkingBlocks，且配置无 thinking', () => {
    const config = parseProvider({ preset: 'minimax', api_key: '${MINIMAX_API_KEY}' });
    expect(config.thinkingMode).toBe('adaptive');
    expect(config.thinkingEffort).toBe('max');
    expect(config.dropThinkingBlocks).toBe(true);
    expect(config.thinking).toBeUndefined();
  });

  it('anthropic / kimi：preset 默认（adaptive 或 thinking:true）', () => {
    const anthropic = parseProvider({ preset: 'anthropic', api_key: '${ANTHROPIC_API_KEY}' });
    expect(anthropic.thinkingMode).toBe('adaptive');
    expect(anthropic.thinkingEffort).toBe('max');

    const kimi = parseProvider({ preset: 'kimi', api_key: '${KIMI_API_KEY}' });
    expect(kimi.thinking).toBe(true);
    expect(kimi.thinkingEffort).toBe('max');
  });

  it('openai 默认 gpt-4o（catalog reasoning:false）→ 不填 thinking', () => {
    const config = parseProvider({ preset: 'openai', api_key: '${OPENAI_API_KEY}' });
    expect(config.thinking).toBeUndefined();
    expect(config.thinkingMode).toBeUndefined();
    expect(config.thinkingEffort).toBeUndefined();
    expect(config.reasoningEffort).toBeUndefined();
  });

  it('openai 显式 o3 → reasoning_effort max', () => {
    const config = parseProvider({ preset: 'openai', api_key: '${OPENAI_API_KEY}', model: 'o3' });
    expect(config.reasoningEffort).toBe('max');
    expect(config.thinkingMode).toBeUndefined();
  });

  it('显式 thinking:false → 整体退出 preset 默认', () => {
    const config = parseProvider({ preset: 'minimax', api_key: '${MINIMAX_API_KEY}', thinking: false });
    expect(config.thinking).toBe(false);
    expect(config.thinkingMode).toBeUndefined();
    expect(config.thinkingEffort).toBeUndefined();
    expect(config.dropThinkingBlocks).toBeUndefined();
  });

  it('显式 thinking_mode/thinking_effort 原样、不混入 preset max', () => {
    const config = parseProvider({
      preset: 'anthropic',
      api_key: '${ANTHROPIC_API_KEY}',
      thinking_mode: 'enabled',
      thinking_effort: 'low',
    });
    expect(config.thinkingMode).toBe('enabled');
    expect(config.thinkingEffort).toBe('low');
    expect(config.thinking).toBeUndefined();
  });

  it('显式 reasoning_effort xhigh → 原样（全档透传）', () => {
    const config = parseProvider({
      preset: 'openai',
      api_key: '${OPENAI_API_KEY}',
      model: 'o3',
      reasoning_effort: 'xhigh',
    });
    expect(config.reasoningEffort).toBe('xhigh');
    expect(config.thinkingMode).toBeUndefined();
  });

  it('schema 接受 minimal/xhigh/max，拒绝未知档位', () => {
    for (const level of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
      expect(llmProviderConfigSchema.parse({ preset: 'openai', thinking_effort: level }).thinking_effort).toBe(level);
      expect(llmProviderConfigSchema.parse({ preset: 'openai', reasoning_effort: level }).reasoning_effort).toBe(level);
    }
    expect(() => llmProviderConfigSchema.parse({ preset: 'openai', thinking_effort: 'ultra' })).toThrow();
  });

  it('provider_id（catalog-only）路径不填 preset 默认', () => {
    const config = parseProvider({ provider_id: 'openai', model: 'gpt-4o', api_key: '${OPENAI_API_KEY}' });
    expect(config.thinking).toBeUndefined();
    expect(config.thinkingMode).toBeUndefined();
    expect(config.thinkingEffort).toBeUndefined();
    expect(config.reasoningEffort).toBeUndefined();
  });
});
