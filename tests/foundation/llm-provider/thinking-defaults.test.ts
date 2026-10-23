/**
 * Phase 1979: preset thinking 默认解析矩阵。
 *
 * - curated reasoning-capable preset 自带默认（effort 全档、默认 max）；
 * - catalog 明确 reasoning:false（openai/gpt-4o）→ 不应用；
 * - catalog 缺失 → 信任 preset；ambient/OAuth/无默认 preset → undefined。
 */
import { describe, it, expect } from 'vitest';
import { resolveThinkingDefaults } from '../../../src/foundation/llm-provider/thinking-defaults.js';

describe('resolveThinkingDefaults', () => {
  it('minimax：adaptive + max + dropThinkingBlocks（auto/默认 model）', () => {
    expect(resolveThinkingDefaults('minimax', undefined)).toEqual({
      thinking_mode: 'adaptive',
      thinking_effort: 'max',
      drop_thinking_blocks: true,
    });
    expect(resolveThinkingDefaults('minimax', 'auto')).toEqual({
      thinking_mode: 'adaptive',
      thinking_effort: 'max',
      drop_thinking_blocks: true,
    });
  });

  it('anthropic / custom-*：adaptive + max', () => {
    expect(resolveThinkingDefaults('anthropic', undefined)).toEqual({
      thinking_mode: 'adaptive',
      thinking_effort: 'max',
    });
    expect(resolveThinkingDefaults('custom-anthropic', 'claude-via-gateway')).toEqual({
      thinking_mode: 'adaptive',
      thinking_effort: 'max',
    });
    expect(resolveThinkingDefaults('custom-openai', 'my-model')).toEqual({
      thinking_mode: 'adaptive',
      thinking_effort: 'max',
    });
    expect(resolveThinkingDefaults('custom-gemini', 'my-model')).toEqual({
      thinking_mode: 'adaptive',
      thinking_effort: 'max',
    });
  });

  it('Anthropic-wire 克隆（deepseek/kimi/qwen/zai/openrouter-anthropic）：thinking + max', () => {
    for (const presetId of ['deepseek', 'kimi', 'qwen', 'zai', 'openrouter-anthropic']) {
      expect(resolveThinkingDefaults(presetId, undefined), presetId).toEqual({
        thinking: true,
        thinking_effort: 'max',
      });
    }
  });

  it('OpenAI 系 preset：reasoning max（catalog reasoning model）', () => {
    expect(resolveThinkingDefaults('openai', 'o3')).toEqual({ reasoning_effort: 'max' });
    expect(resolveThinkingDefaults('moonshot', undefined)).toEqual({ reasoning_effort: 'max' });
    expect(resolveThinkingDefaults('grok', undefined)).toEqual({ reasoning_effort: 'max' });
    // openrouter 默认 model openai/gpt-4o 在 catalog 明确 reasoning:false → 跳过；
    // 换成 reasoning model 时应用 max。
    expect(resolveThinkingDefaults('openrouter', undefined)).toBeUndefined();
    expect(resolveThinkingDefaults('openrouter', 'openai/o3')).toEqual({ reasoning_effort: 'max' });
    expect(resolveThinkingDefaults('gemini', undefined)).toEqual({ reasoning_effort: 'max' });
  });

  it('catalog 明确 reasoning:false（openai/gpt-4o）→ 不应用默认', () => {
    expect(resolveThinkingDefaults('openai', 'gpt-4o')).toBeUndefined();
  });

  it('catalog 缺失 → 信任 preset', () => {
    expect(resolveThinkingDefaults('openai', 'gpt-99-unknown')).toEqual({ reasoning_effort: 'max' });
  });

  it('无 thinkingDefaults 的 preset（ollama/qwen-coder/ambient/OAuth）→ undefined', () => {
    for (const presetId of ['ollama', 'qwen-coder', 'amazon-bedrock', 'google-vertex', 'openai-codex', 'github-copilot']) {
      expect(resolveThinkingDefaults(presetId, undefined), presetId).toBeUndefined();
    }
  });
});
