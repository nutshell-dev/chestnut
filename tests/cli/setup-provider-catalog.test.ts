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

  it('用户名称与服务映射（GLM → zai、Qwen → qwen、Kimi → kimi）', () => {
    expect(resolveSetupProviderTarget('glm')).toEqual({ preset: 'zai' });
    // Phase 1973：Qwen 改指 curated Anthropic preset；qwen-coder 保留为 legacy。
    expect(resolveSetupProviderTarget('qwen')).toEqual({ preset: 'qwen' });
    expect(resolveSetupProviderTarget('kimi')).toEqual({ preset: 'kimi' });
    expect(findSetupProvider('ollama')?.auth).toBe('local');
  });
});

describe('SETUP_PROVIDER_CATALOG — Phase 1973 五家多端点候选', () => {
  it('DeepSeek 1 个候选', () => {
    expect(findSetupProvider('deepseek')?.probeCandidates?.map(c => c.baseUrl)).toEqual([
      'https://api.deepseek.com/anthropic',
    ]);
  });

  it('Kimi 4 个候选且顺序固定', () => {
    expect(findSetupProvider('kimi')?.probeCandidates?.map(c => c.baseUrl)).toEqual([
      'https://api.kimi.com/coding',
      'https://api.kimi.ai/coding',
      'https://api.moonshot.cn/anthropic',
      'https://api.moonshot.ai/anthropic',
    ]);
  });

  it('Qwen 7 个候选且顺序固定', () => {
    expect(findSetupProvider('qwen')?.probeCandidates?.map(c => c.baseUrl)).toEqual([
      'https://dashscope.aliyuncs.com/apps/anthropic',
      'https://dashscope-intl.aliyuncs.com/apps/anthropic',
      'https://dashscope-us.aliyuncs.com/apps/anthropic',
      'https://cn-hongkong.dashscope.aliyuncs.com/apps/anthropic',
      'https://coding-intl.dashscope.aliyuncs.com/apps/anthropic',
      'https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic',
      'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic',
    ]);
  });

  it('GLM 2 个候选且顺序固定', () => {
    expect(findSetupProvider('glm')?.probeCandidates?.map(c => c.baseUrl)).toEqual([
      'https://open.bigmodel.cn/api/anthropic',
      'https://api.z.ai/api/anthropic',
    ]);
  });

  it('MiniMax 2 个候选且顺序固定', () => {
    expect(findSetupProvider('minimax')?.probeCandidates?.map(c => c.baseUrl)).toEqual([
      'https://api.minimax.cn/anthropic',
      'https://api.minimax.io/anthropic',
    ]);
  });

  it('候选 presetId 均注册且为 anthropic preset', () => {
    for (const id of ['deepseek', 'kimi', 'qwen', 'glm', 'minimax'] as const) {
      const candidates = findSetupProvider(id)?.probeCandidates;
      expect(candidates?.length, `${id} 应有候选`).toBeGreaterThan(0);
      for (const c of candidates!) {
        const preset = PRESETS[c.presetId];
        expect(preset, `${id} 候选 preset ${c.presetId} 未注册`).toBeDefined();
        expect(preset.apiFormat, `${id} 候选 preset ${c.presetId} 应为 anthropic`).toBe('anthropic');
      }
    }
  });

  it('非五家服务无 probeCandidates（保持单 endpoint 流程）', () => {
    for (const id of ['openai', 'gemini', 'anthropic', 'grok', 'openrouter', 'ollama', 'other'] as const) {
      expect(findSetupProvider(id)?.probeCandidates, `${id} 不应有候选`).toBeUndefined();
    }
  });

  it('五家默认模型与 preset 一致（Phase 1973 curated）', () => {
    expect(findSetupProvider('deepseek')?.defaultModel).toBe('deepseek-flash[1m]');
    expect(findSetupProvider('kimi')?.defaultModel).toBe('k3-256k');
    expect(findSetupProvider('qwen')?.defaultModel).toBe('qwen3.8-max');
    expect(findSetupProvider('glm')?.defaultModel).toBe('glm-5.3');
    expect(findSetupProvider('minimax')?.defaultModel).toBe('MiniMax-M3.1-Flash');
  });
});
