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

export interface SetupProviderChoice {
  id: SetupProviderId;
  label: string;
  description: string;
  target: SetupProviderTarget;
  auth: 'api_key' | 'local' | 'advanced';
  defaultModel?: string;
  envVar?: string;
}

function presetChoice(
  id: SetupProviderId,
  label: string,
  description: string,
  presetId: string,
  auth: 'api_key' | 'local' = 'api_key',
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
  };
}

/** 用户确认的固定顺序（不要按对象/枚举顺序生成）。 */
export const SETUP_PROVIDER_CATALOG: readonly SetupProviderChoice[] = [
  presetChoice('deepseek', 'DeepSeek', 'DeepSeek API', 'deepseek'),
  presetChoice('kimi', 'Kimi', 'Kimi Coding', 'kimi'),
  presetChoice('qwen', 'Qwen', 'Qwen Coder / DashScope', 'qwen-coder'),
  presetChoice('glm', 'GLM', 'Z.AI GLM', 'zai'),
  presetChoice('minimax', 'MiniMax', 'MiniMax API', 'minimax'),
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
