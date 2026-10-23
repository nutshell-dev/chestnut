/**
 * Phase 1979: pi-ai Model 的 thinking 能力派生。
 *
 * - metadata-only 路径保留 catalog 的 forceAdaptiveThinking / thinkingLevelMap，
 *   但不接管 wire（api/baseUrl/model id 仍由 preset/config 决定）；
 * - 自建 Model 的 reasoning 由 thinkingMode/thinkingEffort/reasoningEffort 派生。
 */
import { describe, it, expect } from 'vitest';
import { llmProviderConfigSchema } from '../../../src/foundation/llm-orchestrator/llm-provider-config-schema.js';
import { toProviderConfig } from '../../../src/foundation/llm-orchestrator/config-adapter.js';
import { loadPiAiRuntime, resolvePiAiModel } from '../../../src/foundation/llm-provider/pi-ai-support.js';

function parseProvider(input: Record<string, unknown>) {
  return toProviderConfig(llmProviderConfigSchema.parse(input));
}

type ThinkingCompat = { forceAdaptiveThinking?: boolean };

describe('resolvePiAiModel thinking metadata', () => {
  it('metadata-only（minimax）：保留 forceAdaptiveThinking / thinkingLevelMap，wire 不被接管', async () => {
    const runtime = await loadPiAiRuntime();
    const config = parseProvider({ preset: 'minimax', api_key: '${MINIMAX_API_KEY}' });
    const { model, fromCatalog } = resolvePiAiModel(runtime, config);

    expect(fromCatalog).toBe(false);
    expect(model.id).toBe('MiniMax-M3.1-Flash');
    expect(model.api).toBe('anthropic-messages');
    expect(model.baseUrl).toBe('https://api.minimax.io/anthropic');
    expect(model.reasoning).toBe(true);
    expect((model.compat as ThinkingCompat | undefined)?.forceAdaptiveThinking).toBe(true);
    expect(model.thinkingLevelMap?.max).toBe('max');
    // 不整包拷贝 compat：OpenAI 特定字段不得进入 Anthropic-wire 克隆
    expect(model.compat).not.toHaveProperty('supportsReasoningEffort');
  });

  it('自建 Model：thinkingMode/thinkingEffort 使 reasoning=true', async () => {
    const runtime = await loadPiAiRuntime();
    const config = parseProvider({
      preset: 'custom-openai',
      api_key: '${CUSTOM_KEY}',
      model: 'my-model',
      base_url: 'https://gateway.example.com/v1',
    });
    expect(config.thinkingMode).toBe('adaptive');
    const { model, fromCatalog } = resolvePiAiModel(runtime, config);
    expect(fromCatalog).toBe(false);
    expect(model.reasoning).toBe(true);
  });

  it('自建 Model：单独 reasoningEffort / thinkingEffort 也能启用 reasoning', async () => {
    const runtime = await loadPiAiRuntime();
    for (const input of [
      { reasoning_effort: 'high' },
      { thinking_effort: 'low' },
      { thinking: true },
    ]) {
      const config = parseProvider({
        preset: 'custom-openai',
        api_key: '${CUSTOM_KEY}',
        model: 'my-model',
        base_url: 'https://gateway.example.com/v1',
        ...input,
      });
      expect(resolvePiAiModel(runtime, config).model.reasoning, JSON.stringify(input)).toBe(true);
    }
  });

  it('自建 Model：显式 thinking:false 且无 mode/effort → reasoning=false', async () => {
    const runtime = await loadPiAiRuntime();
    const config = parseProvider({
      preset: 'custom-openai',
      api_key: '${CUSTOM_KEY}',
      model: 'my-model',
      base_url: 'https://gateway.example.com/v1',
      thinking: false,
    });
    expect(resolvePiAiModel(runtime, config).model.reasoning).toBe(false);
  });
});
