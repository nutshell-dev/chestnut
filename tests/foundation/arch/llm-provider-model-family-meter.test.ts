import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const providerRoot = new URL('../../../src/foundation/llm-provider/', import.meta.url);
const source = (name: string): string => readFileSync(new URL(name, providerRoot), 'utf8');

describe('LLMProvider model-family meter boundary', () => {
  it('keeps family resolution independent of resolved provider and request wire facts', () => {
    const resolver = source('model-family-resolver.ts');
    expect(resolver).not.toMatch(/CatalogResolution|ProviderConfig|PiAi|baseUrl|resolution\./u);
    const registry = source('input-meter.ts');
    expect(registry).toContain('resolveModelFamily(model.id)');
    expect(registry).not.toContain('profile.matches(');
  });

  it('keeps final request projection and fresh counted results out of local meters', () => {
    for (const name of [
      'input-meter.ts', 'deepseek-input-profile.ts', 'deepseek-v41-meter.ts',
      'kimi-k3-text-meter.ts', 'qwen-text-meter.ts', 'glm53-text-meter.ts', 'pi-ai-adapter.ts',
    ]) {
      const text = source(name);
      expect(text).not.toMatch(/deepseek-input-projection|buildApiKeyRequest|renderDeepseekV41/u);
      expect(text).not.toContain("kind: 'counted'");
    }
    expect(existsSync(new URL('deepseek-input-projection.ts', providerRoot))).toBe(false);
    expect(existsSync(new URL('deepseek-v41-renderer.ts', providerRoot))).toBe(false);
  });
});
