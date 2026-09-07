/**
 * Provider Preset System
 * Defines known providers and their configurations
 */

export type ApiFormat = 'anthropic' | 'openai' | 'gemini';
type AuthMethod = 'api_key';

/**
 * phase 1793: LLMProvider-owned typed error（unknown-preset-generic-error 治理）。
 *
 * 保留原始 preset id 与不可变 available ids，caller 可 instanceof 机械区分
 * 用户配置错误与 provider 内部故障，无需字符串反解析。
 * owner-local type：仅在真实 caller 需要机械区分时才经 barrel 暴露（Step A 风险条）。
 */
export class UnknownPresetError extends Error {
  readonly presetId: string;
  readonly availablePresetIds: readonly string[];
  constructor(presetId: string, availablePresetIds: readonly string[]) {
    super(`Unknown provider preset "${presetId}". Available presets: ${availablePresetIds.join(', ')}`);
    this.name = 'UnknownPresetError';
    this.presetId = presetId;
    this.availablePresetIds = Object.freeze([...availablePresetIds]);
  }
}

interface ProviderPreset {
  id: string;
  displayName: string;
  apiFormat: ApiFormat;
  authMethod: AuthMethod;
  defaultBaseUrl?: string;
  defaultModel?: string;
  /** Environment variable name for the API key (e.g. ANTHROPIC_API_KEY) */
  envVar?: string;
}

export const PRESETS: Record<string, ProviderPreset> = {
  'anthropic': {
    id: 'anthropic',
    displayName: 'Anthropic',
    apiFormat: 'anthropic',
    authMethod: 'api_key',
    defaultBaseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-3-7-sonnet-20250219',
    envVar: 'ANTHROPIC_API_KEY',
  },
  'openai': {
    id: 'openai',
    displayName: 'OpenAI',
    apiFormat: 'openai',
    authMethod: 'api_key',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o',
    envVar: 'OPENAI_API_KEY',
  },
  'deepseek': {
    id: 'deepseek',
    displayName: 'DeepSeek',
    apiFormat: 'openai',
    authMethod: 'api_key',
    defaultBaseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-chat',
    envVar: 'DEEPSEEK_API_KEY',
  },
  'moonshot': {
    id: 'moonshot',
    displayName: 'Moonshot AI',
    apiFormat: 'openai',
    authMethod: 'api_key',
    defaultBaseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'kimi-k2.5',
    envVar: 'MOONSHOT_API_KEY',
  },
  'kimi': {
    id: 'kimi',
    displayName: 'Kimi (Coding)',
    apiFormat: 'anthropic',
    authMethod: 'api_key',
    defaultBaseUrl: 'https://api.kimi.com/coding',
    defaultModel: 'kimi-k2.5',
    envVar: 'KIMI_API_KEY',
  },
  'minimax': {
    id: 'minimax',
    displayName: 'MiniMax',
    apiFormat: 'anthropic',
    authMethod: 'api_key',
    defaultBaseUrl: 'https://api.minimax.io/anthropic',
    defaultModel: 'MiniMax-M1',
    envVar: 'MINIMAX_API_KEY',
  },
  'gemini': {
    id: 'gemini',
    displayName: 'Google Gemini',
    apiFormat: 'gemini',
    authMethod: 'api_key',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: 'gemini-2.5-pro-preview-03-25',
    envVar: 'GEMINI_API_KEY',
  },
  'ollama': {
    id: 'ollama',
    displayName: 'Ollama',
    apiFormat: 'openai',
    authMethod: 'api_key',
    defaultBaseUrl: 'http://localhost:11434/v1',
    defaultModel: 'llama3.1',
    envVar: 'OLLAMA_API_KEY',
  },
  'grok': {
    id: 'grok',
    displayName: 'xAI Grok',
    apiFormat: 'openai',
    authMethod: 'api_key',
    defaultBaseUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-4',
    envVar: 'XAI_API_KEY',
  },
  'openrouter': {
    id: 'openrouter',
    displayName: 'OpenRouter',
    apiFormat: 'openai',
    authMethod: 'api_key',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-4o',
    envVar: 'OPENROUTER_API_KEY',
  },
  'openrouter-anthropic': {
    id: 'openrouter-anthropic',
    displayName: 'OpenRouter (Anthropic format)',
    apiFormat: 'anthropic',
    authMethod: 'api_key',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'anthropic/claude-sonnet-4-5',
    envVar: 'OPENROUTER_API_KEY',
  },
  'zai': {
    id: 'zai',
    displayName: 'Z.AI (Anthropic format)',
    apiFormat: 'anthropic',
    authMethod: 'api_key',
    defaultBaseUrl: 'https://api.z.ai/api/anthropic',
    defaultModel: 'glm-4.6',
    envVar: 'ZAI_API_KEY',
  },
  'qwen-coder': {
    id: 'qwen-coder',
    displayName: 'Qwen Coder (Alibaba)',
    apiFormat: 'openai',
    authMethod: 'api_key',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-coder-plus-latest',
    envVar: 'DASHSCOPE_API_KEY',
  },
  'custom-anthropic': {
    id: 'custom-anthropic',
    displayName: 'Custom (Anthropic Format)',
    apiFormat: 'anthropic',
    authMethod: 'api_key',
  },
  'custom-openai': {
    id: 'custom-openai',
    displayName: 'Custom (OpenAI Format)',
    apiFormat: 'openai',
    authMethod: 'api_key',
  },
  'custom-gemini': {
    id: 'custom-gemini',
    displayName: 'Custom (Gemini Format)',
    apiFormat: 'gemini',
    authMethod: 'api_key',
  },
};

export function resolvePreset(id: string): ProviderPreset {
  const preset = PRESETS[id];
  if (!preset) {
    // phase 1793: typed error；available 由 PRESETS 单源派生，caller 不得重算。
    // 保留 Object.keys 既有顺序 —— message 字节兼容（既有断言/展示 0 漂移）。
    throw new UnknownPresetError(id, Object.keys(PRESETS));
  }
  return preset;
}
