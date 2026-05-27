/**
 * resolvePreset() tests — Phase 20 preset system
 */
import { describe, it, expect } from 'vitest';
import { resolvePreset } from '../../src/foundation/llm-provider/presets.js';

describe('resolvePreset', () => {
  it('should return anthropic preset with apiFormat=anthropic and defaultBaseUrl', () => {
    const preset = resolvePreset('anthropic');
    expect(preset.apiFormat).toBe('anthropic');
    expect(preset.defaultBaseUrl).toBe('https://api.anthropic.com');
    expect(preset.defaultModel).toBeTruthy();
  });

  it('should return deepseek preset with apiFormat=openai', () => {
    const preset = resolvePreset('deepseek');
    expect(preset.apiFormat).toBe('openai');
    expect(preset.defaultBaseUrl).toContain('deepseek');
  });

  it('should return minimax preset with apiFormat=anthropic (MiniMax uses Anthropic-compatible API)', () => {
    const preset = resolvePreset('minimax');
    expect(preset.apiFormat).toBe('anthropic');
    expect(preset.defaultModel).toBe('MiniMax-M1');
  });

  it('should return custom-openai with apiFormat=openai and no defaultBaseUrl', () => {
    const preset = resolvePreset('custom-openai');
    expect(preset.apiFormat).toBe('openai');
    expect(preset.defaultBaseUrl).toBeUndefined();
  });

  it('should return custom-anthropic with apiFormat=anthropic and no defaultBaseUrl', () => {
    const preset = resolvePreset('custom-anthropic');
    expect(preset.apiFormat).toBe('anthropic');
    expect(preset.defaultBaseUrl).toBeUndefined();
  });

  it('should throw for unknown preset ID with available list in message', () => {
    expect(() => resolvePreset('nonexistent-provider')).toThrow(/Unknown provider preset/);
    // Error message includes available presets
    expect(() => resolvePreset('nonexistent-provider')).toThrow(/anthropic/);
    expect(() => resolvePreset('nonexistent-provider')).toThrow(/openai/);
  });
});

// Phase 81: envVar 字段
import { PRESETS } from '../../src/foundation/llm-provider/presets.js';

describe('PRESETS envVar — Phase 81 env var 自动识别', () => {
  it('anthropic 有 envVar=ANTHROPIC_API_KEY', () => {
    expect(PRESETS['anthropic'].envVar).toBe('ANTHROPIC_API_KEY');
  });

  it('openai 有 envVar=OPENAI_API_KEY', () => {
    expect(PRESETS['openai'].envVar).toBe('OPENAI_API_KEY');
  });

  it('deepseek 有 envVar=DEEPSEEK_API_KEY', () => {
    expect(PRESETS['deepseek'].envVar).toBe('DEEPSEEK_API_KEY');
  });

  it('gemini 有 envVar=GEMINI_API_KEY', () => {
    expect(PRESETS['gemini'].envVar).toBe('GEMINI_API_KEY');
  });

  it('custom-anthropic 无 envVar（自定义 provider 不自动检测）', () => {
    expect(PRESETS['custom-anthropic'].envVar).toBeUndefined();
  });

  it('custom-openai 无 envVar', () => {
    expect(PRESETS['custom-openai'].envVar).toBeUndefined();
  });

  it('所有已知非 custom preset 均有 envVar 字段', () => {
    const knownPresets = ['anthropic', 'openai', 'deepseek', 'moonshot', 'minimax', 'gemini', 'ollama'];
    for (const id of knownPresets) {
      expect(PRESETS[id].envVar, `${id} 应有 envVar`).toBeTruthy();
    }
  });
});
