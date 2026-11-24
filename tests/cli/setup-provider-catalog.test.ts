/** Phase 2207: explicit configuration-method descriptors and draft contract. */
import { describe, it, expect } from 'vitest';
import {
  SETUP_PROVIDER_CATALOG,
  SETUP_PROVIDER_ORDER,
  createExplicitSetupDraft,
  findSetupProvider,
  makeExplicitSetupDraft,
} from '../../src/cli/setup-provider-catalog.js';
import { setupProviderMenuLines } from '../../src/templates/messages/index.js';

const FIXED_METHODS = [
  'deepseek', 'kimi', 'qwen', 'glm', 'minimax', 'openai', 'anthropic', 'gemini', 'grok',
] as const;

describe('SETUP_PROVIDER_CATALOG', () => {
  it('固定九个服务加 Custom，顺序稳定', () => {
    expect(SETUP_PROVIDER_ORDER).toEqual([...FIXED_METHODS, 'other']);
    expect(SETUP_PROVIDER_CATALOG).toHaveLength(10);
  });

  it('每个 fixed descriptor 直接携带显式身份、协议、端点、模型和认证', () => {
    for (const id of FIXED_METHODS) {
      const choice = findSetupProvider(id)!;
      expect(choice.providerId, id).toBeTruthy();
      expect(choice.apiFormat, id).toBeTruthy();
      expect(choice.defaultBaseUrl, id).toBeTruthy();
      expect(choice.defaultModel, id).toBeTruthy();
      expect(choice.authProfile, id).toBe('api_key');
      expect(choice.envVar, id).toBeTruthy();
      expect(choice).not.toHaveProperty('preset');
      expect(choice).not.toHaveProperty('presetId');
    }
  });

  it('用户可见名称与菜单位置固定', () => {
    expect(findSetupProvider('kimi')?.description).toBe('Moonshot AI');
    expect(findSetupProvider('qwen')?.description).toBe('Qwen / DashScope');
    expect(findSetupProvider('glm')?.description).toBe('Zhipu / Z.AI');
    expect(findSetupProvider('glm')?.providerId).toBe('zai');
    expect(findSetupProvider('gemini')?.providerId).toBe('google');
    expect(findSetupProvider('grok')?.providerId).toBe('xai');
    const menu = setupProviderMenuLines(SETUP_PROVIDER_CATALOG).join('\n');
    expect(menu).toContain('Moonshot AI');
    expect(menu).toContain('Qwen / DashScope');
    expect(menu).toContain('Zhipu / Z.AI');
  });

  it('unknown method 不解析为任何 descriptor', () => {
    expect(findSetupProvider('seed')).toBeUndefined();
    expect(findSetupProvider('amazon-bedrock')).toBeUndefined();
  });

  it('custom draft 直接包含 protocol/base URL/model/key，不含 preset', () => {
    const choice = findSetupProvider('other')!;
    const input = createExplicitSetupDraft(choice, {
      apiFormat: 'openai', apiKey: '${CUSTOM_KEY}', model: 'my-model', baseUrl: 'https://example.test/v1',
    });
    const draft = makeExplicitSetupDraft(input);
    expect(draft.provider).toMatchObject({
      provider_id: 'custom:openai', api_format: 'openai', auth_profile: 'api_key',
      api_key: '${CUSTOM_KEY}', model: 'my-model', base_url: 'https://example.test/v1',
    });
    expect(draft.provider).not.toHaveProperty('preset');
    expect(input).not.toHaveProperty('presetId');
  });

  it('显式 baseUrl 优先于候选目录，不将 key 发往未指定 endpoint', () => {
    const choice = findSetupProvider('kimi')!;
    const input = createExplicitSetupDraft(choice, {
      apiKey: '${KIMI_API_KEY}', model: 'custom-model', baseUrl: 'https://private.example/anthropic',
    });
    const draft = makeExplicitSetupDraft(input);
    expect(draft.candidates).toBeUndefined();
    expect(draft.provider.base_url).toBe('https://private.example/anthropic');
  });

  it('builder 对 ambient/OAuth fail closed，不伪造 API key', () => {
    const choice = findSetupProvider('other')!;
    for (const authProfile of ['ambient', 'oauth'] as const) {
      const input = createExplicitSetupDraft(choice, {
        apiFormat: 'openai', model: 'my-model', baseUrl: 'https://example.test/v1', authProfile,
      });
      expect(() => makeExplicitSetupDraft(input)).toThrow(/api_key/);
    }
  });
});

describe('SETUP_PROVIDER_CATALOG — ordered explicit endpoint candidates', () => {
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

  it('GLM 和 MiniMax 各 2 个候选', () => {
    expect(findSetupProvider('glm')?.probeCandidates?.map(c => c.baseUrl)).toEqual([
      'https://open.bigmodel.cn/api/anthropic', 'https://api.z.ai/api/anthropic',
    ]);
    expect(findSetupProvider('minimax')?.probeCandidates?.map(c => c.baseUrl)).toEqual([
      'https://api.minimax.cn/anthropic', 'https://api.minimax.io/anthropic',
    ]);
  });

  it('每个候选直接携带 explicit provider/protocol/model/base URL', () => {
    for (const id of ['deepseek', 'kimi', 'qwen', 'glm', 'minimax'] as const) {
      const candidates = findSetupProvider(id)?.probeCandidates;
      expect(candidates?.length, id).toBeGreaterThan(0);
      for (const candidate of candidates!) {
        expect(candidate.providerId).toBeTruthy();
        expect(candidate.apiFormat).toBe('anthropic');
        expect(candidate.authProfile).toBe('api_key');
        expect(candidate.model).toBe(findSetupProvider(id)?.defaultModel);
        expect(candidate).not.toHaveProperty('presetId');
      }
    }
  });

  it('其余方法无多候选，五家默认模型保持既定矩阵', () => {
    for (const id of ['openai', 'anthropic', 'gemini', 'grok', 'other'] as const) {
      expect(findSetupProvider(id)?.probeCandidates).toBeUndefined();
    }
    expect(findSetupProvider('deepseek')?.defaultModel).toBe('deepseek-flash[1m]');
    expect(findSetupProvider('kimi')?.defaultModel).toBe('k3-256k');
    expect(findSetupProvider('qwen')?.defaultModel).toBe('qwen3.8-max');
    expect(findSetupProvider('glm')?.defaultModel).toBe('glm-5.3');
    expect(findSetupProvider('minimax')?.defaultModel).toBe('MiniMax-M3.1-Flash');
  });
});
