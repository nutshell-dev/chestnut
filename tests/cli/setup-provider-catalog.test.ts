/**
 * Phase 1972: 首次初始化服务目录 — 固定 12 项、顺序、映射与 Seed 排除。
 */
import { describe, it, expect } from 'vitest';
import {
  SETUP_PROVIDER_CATALOG,
  SETUP_PROVIDER_ORDER,
  findSetupProvider,
  resolveSetupProviderTarget,
} from '../../src/cli/setup-provider-catalog.js';
import { PRESETS } from '../../src/foundation/llm-provider/index.js';

describe('SETUP_PROVIDER_CATALOG', () => {
  it('固定 12 项且顺序稳定', () => {
    expect(SETUP_PROVIDER_ORDER).toEqual([
      'deepseek', 'kimi', 'qwen', 'glm', 'minimax', 'openai',
      'gemini', 'anthropic', 'grok', 'openrouter', 'ollama', 'other',
    ]);
    expect(SETUP_PROVIDER_CATALOG).toHaveLength(12);
  });

  it('Seed 不是独立服务', () => {
    expect(SETUP_PROVIDER_CATALOG.some(choice => choice.id === 'seed')).toBe(false);
    expect(findSetupProvider('seed')).toBeUndefined();
  });

  it('除 Other 外都映射到存在的内部 preset', () => {
    for (const choice of SETUP_PROVIDER_CATALOG) {
      if (choice.id === 'other') {
        expect(choice.auth).toBe('advanced');
        expect(choice.target).toEqual({});
        continue;
      }
      expect(choice.target.preset).toBeDefined();
      expect(PRESETS[choice.target.preset!]).toBeDefined();
      expect(choice.defaultModel ?? PRESETS[choice.target.preset!].defaultModel).toBeDefined();
    }
  });

  it('用户名称与服务映射（GLM → zai、Qwen → qwen-coder、Kimi → kimi）', () => {
    expect(resolveSetupProviderTarget('glm')).toEqual({ preset: 'zai' });
    expect(resolveSetupProviderTarget('qwen')).toEqual({ preset: 'qwen-coder' });
    expect(resolveSetupProviderTarget('kimi')).toEqual({ preset: 'kimi' });
    expect(findSetupProvider('ollama')?.auth).toBe('local');
  });
});
