/**
 * Provider Preset System
 * Defines known providers and their configurations
 */

export type ApiFormat = 'anthropic' | 'openai' | 'gemini';
export type AuthMethod = 'api_key' | 'oauth' | 'aws_credentials';

export interface ProviderPreset {
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
    const available = Object.keys(PRESETS).join(', ');
    throw new Error(
      `Unknown provider preset "${id}". Available presets: ${available}`
    );
  }
  return preset;
}
