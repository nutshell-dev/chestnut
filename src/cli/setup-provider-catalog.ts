/**
 * Phase 1972: 首次初始化 / provider add 的用户服务目录。
 *
 * 用户只看到固定的 12 项服务；内部 preset/provider id 映射留在本模块，
 * 不从 PRESETS / catalog inventory 全量枚举。Seed 不属于独立服务；需要 Seed
 * 模型时走 OpenRouter + 高级模型输入。
 */

import { PRESETS } from '../foundation/llm-provider/index.js';

export type SetupProviderId =
  | 'deepseek'
  | 'kimi'
  | 'qwen'
  | 'glm'
  | 'minimax'
  | 'openai'
  | 'gemini'
  | 'anthropic'
  | 'grok'
  | 'openrouter'
  | 'ollama'
  | 'other';

export interface SetupProviderTarget {
  /** 内部 preset id（catalog preset 别名）。 */
  preset?: string;
  /** 显式 catalog provider id。 */
  providerId?: string;
}

/**
 * Phase 1973 Step C：setup 多端点候选——同一 preset 下的 Anthropic baseUrl
 * 候选（地域/套餐差异），按序 probe，首胜者显式写入配置 base_url。
 */
export interface SetupProbeCandidate {
  /** 该候选使用的 chestnut preset id。 */
  presetId: string;
  /** 候选 Anthropic base URL（不含 /v1/messages）。 */
  baseUrl: string;
  /** CLI 进度显示名。 */
  label: string;
}

// 五家候选端点固定顺序（Phase 1973 Step A 端点矩阵；改动需同步 design/测试）。
const DEEPSEEK_CANDIDATES: readonly SetupProbeCandidate[] = [
  { presetId: 'deepseek', baseUrl: 'https://api.deepseek.com/anthropic', label: 'DeepSeek (Anthropic)' },
];

const KIMI_CANDIDATES: readonly SetupProbeCandidate[] = [
  { presetId: 'kimi', baseUrl: 'https://api.kimi.com/coding', label: 'Kimi Code (CN)' },
  { presetId: 'kimi', baseUrl: 'https://api.kimi.ai/coding', label: 'Kimi Code (Global)' },
  { presetId: 'kimi', baseUrl: 'https://api.moonshot.cn/anthropic', label: 'Kimi Open (CN)' },
  { presetId: 'kimi', baseUrl: 'https://api.moonshot.ai/anthropic', label: 'Kimi Open (Global)' },
];

const QWEN_CANDIDATES: readonly SetupProbeCandidate[] = [
  { presetId: 'qwen', baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic', label: 'Qwen (CN)' },
  { presetId: 'qwen', baseUrl: 'https://dashscope-intl.aliyuncs.com/apps/anthropic', label: 'Qwen (Intl)' },
  { presetId: 'qwen', baseUrl: 'https://dashscope-us.aliyuncs.com/apps/anthropic', label: 'Qwen (US)' },
  { presetId: 'qwen', baseUrl: 'https://cn-hongkong.dashscope.aliyuncs.com/apps/anthropic', label: 'Qwen (HK)' },
  { presetId: 'qwen', baseUrl: 'https://coding-intl.dashscope.aliyuncs.com/apps/anthropic', label: 'Qwen Coding Plan (Intl)' },
  { presetId: 'qwen', baseUrl: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic', label: 'Qwen Token Plan (Intl)' },
  { presetId: 'qwen', baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic', label: 'Qwen Token Plan (CN)' },
];

const GLM_CANDIDATES: readonly SetupProbeCandidate[] = [
  { presetId: 'zai', baseUrl: 'https://open.bigmodel.cn/api/anthropic', label: 'GLM Coding Plan (CN)' },
  { presetId: 'zai', baseUrl: 'https://api.z.ai/api/anthropic', label: 'GLM Coding Plan (Intl)' },
];

const MINIMAX_CANDIDATES: readonly SetupProbeCandidate[] = [
  { presetId: 'minimax', baseUrl: 'https://api.minimax.cn/anthropic', label: 'MiniMax (CN)' },
  { presetId: 'minimax', baseUrl: 'https://api.minimax.io/anthropic', label: 'MiniMax (Intl)' },
];

export interface SetupProviderChoice {
  id: SetupProviderId;
  label: string;
  description: string;
  target: SetupProviderTarget;
  auth: 'api_key' | 'local' | 'advanced';
  defaultModel?: string;
  envVar?: string;
  /**
   * Phase 1973 Step C：存在且非空时，setup 按序 probe 候选端点，首胜者
   * baseUrl 显式落盘；全败不保存。非五家服务缺席（保持单 endpoint 流程）。
   */
  probeCandidates?: readonly SetupProbeCandidate[];
}

function presetChoice(
  id: SetupProviderId,
  label: string,
  description: string,
  presetId: string,
  auth: 'api_key' | 'local' = 'api_key',
  probeCandidates?: readonly SetupProbeCandidate[],
): SetupProviderChoice {
  const preset = PRESETS[presetId];
  if (!preset) {
    throw new Error(`setup provider catalog: preset "${presetId}" is not registered (id=${id})`);
  }
  return {
    id,
    label,
    description,
    target: { preset: presetId },
    auth,
    ...(preset.defaultModel !== undefined && { defaultModel: preset.defaultModel }),
    ...(preset.envVar !== undefined && { envVar: preset.envVar }),
    ...(probeCandidates !== undefined && { probeCandidates }),
  };
}

/** 用户确认的固定顺序（不要按对象/枚举顺序生成）。 */
export const SETUP_PROVIDER_CATALOG: readonly SetupProviderChoice[] = [
  presetChoice('deepseek', 'DeepSeek', 'DeepSeek API', 'deepseek', 'api_key', DEEPSEEK_CANDIDATES),
  presetChoice('kimi', 'Kimi', 'Kimi Coding', 'kimi', 'api_key', KIMI_CANDIDATES),
  presetChoice('qwen', 'Qwen', 'Qwen / DashScope (Anthropic)', 'qwen', 'api_key', QWEN_CANDIDATES),
  presetChoice('glm', 'GLM', 'Z.AI GLM', 'zai', 'api_key', GLM_CANDIDATES),
  presetChoice('minimax', 'MiniMax', 'MiniMax API', 'minimax', 'api_key', MINIMAX_CANDIDATES),
  presetChoice('openai', 'OpenAI', 'OpenAI API', 'openai'),
  presetChoice('gemini', 'Gemini', 'Google Gemini API', 'gemini'),
  presetChoice('anthropic', 'Anthropic', 'Anthropic Claude API', 'anthropic'),
  presetChoice('grok', 'Grok', 'xAI Grok API', 'grok'),
  presetChoice('openrouter', 'OpenRouter', 'OpenRouter API', 'openrouter'),
  presetChoice('ollama', 'Ollama', 'Local Ollama (no API key)', 'ollama', 'local'),
  {
    id: 'other',
    label: 'Other',
    description: 'Custom OpenAI/Anthropic/Gemini-compatible endpoint',
    target: {},
    auth: 'advanced',
  },
];

export const SETUP_PROVIDER_ORDER: readonly SetupProviderId[] =
  SETUP_PROVIDER_CATALOG.map(choice => choice.id);

export function findSetupProvider(id: string): SetupProviderChoice | undefined {
  return SETUP_PROVIDER_CATALOG.find(choice => choice.id === id);
}

export function isSetupProviderId(value: string): value is SetupProviderId {
  return SETUP_PROVIDER_CATALOG.some(choice => choice.id === value);
}

/** 解析用户服务 id → 内部 preset/provider；Other 返回 undefined（走高级输入）。 */
export function resolveSetupProviderTarget(
  id: string,
): SetupProviderTarget | undefined {
  return findSetupProvider(id)?.target;
}
