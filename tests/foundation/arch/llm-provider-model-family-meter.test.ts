import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const providerRoot = new URL('../../../src/foundation/llm-provider/', import.meta.url);
const source = (name: string): string => readFileSync(new URL(name, providerRoot), 'utf8');

describe('LLMProvider model-family meter boundary', () => {
  it('keeps family resolution independent of resolved provider and request wire facts', () => {
    const resolver = source('model-family-resolver.ts');
    expect(resolver).not.toMatch(/CatalogResolution|ProviderConfig|PiAi|baseUrl|resolution\./u);
    const registry = source('input-meter.ts');
    expect(registry).toContain('function matchingProfile(configuredModel: string)');
    expect(registry).toContain('resolveModelFamily(configuredModel)');
    expect(registry).toContain('matchingProfile(configuredModel)');
    expect(registry).toContain('matchingProfile(config.model)');
    expect(registry).not.toContain('matchingProfile(model)');
    expect(registry).not.toContain('resolveModelFamily(model.id)');
    expect(registry).not.toContain('profile.matches(');
  });

  it('keeps final request projection and fresh counted results out of local meters', () => {
    for (const name of [
      'input-meter.ts', 'deepseek-input-profile.ts', 'deepseek-v41-meter.ts',
      'kimi-k3-text-meter.ts', 'qwen-text-meter.ts', 'glm53-text-meter.ts', 'pi-ai-adapter.ts',
      'common-input-projection.ts', 'input-meter-asset.ts',
    ]) {
      const text = source(name);
      expect(text).not.toMatch(/deepseek-input-projection|buildApiKeyRequest|renderDeepseekV41/u);
      expect(text).not.toContain("kind: 'counted'");
    }
    expect(existsSync(new URL('deepseek-input-projection.ts', providerRoot))).toBe(false);
    expect(existsSync(new URL('deepseek-v41-renderer.ts', providerRoot))).toBe(false);
  });

  it('keeps common projection offline, bounded, and separate from credentials or usage', () => {
    const projection = source('common-input-projection.ts');
    const assets = source('input-meter-asset.ts');
    for (const text of [projection, assets]) {
      expect(text).not.toMatch(/ProviderUsage|apiKey|baseUrl|fetch\(|writeFile|pi-ai/u);
    }
    expect(projection).toMatch(/MAX_TOOLS|MAX_CONTENT_PARTS|MAX_STRUCTURED_DEPTH|maxInputBytes|maxMessages/u);
    expect(assets).toMatch(/MAX_CACHE_BYTES|MAX_CACHE_ENTRIES|MAX_ASSET_OWNERS/u);
    expect(assets).toContain('${profile}\\0${assetRevision}\\0${projectionRevision}');
  });
});
