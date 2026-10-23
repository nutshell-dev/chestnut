/**
 * Provider Preset System
 * Defines known providers and their configurations
 */

export type ApiFormat = 'anthropic' | 'openai' | 'gemini';

/**
 * Phase 1926 Step D：preset 的认证装配类别（CLI 提示与缺参判定依据）。
 * - api_key：配置必须带 api_key（${REF} 或明文经 Credentials owner 落凭据文件）；
 * - ambient：pi-ai builtin provider 原生环境解析（AWS profile/default chain、
 *   Google ADC、provider env）——配置无需 api_key，请求期由 pi-ai auth.resolve 判定；
 * - oauth：pi-ai OAuth 凭证（access/refresh），经 `config provider login` 交互登录、
 *   由用户级 Credentials owner 持久化（pi-ai CredentialStore 桥接）。
 */
export type AuthProfile = 'api_key' | 'ambient' | 'oauth';

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
  /**
   * 自建 Model 路径的显式协议声明。catalog 命中（piAiProvider + model 命中）时
   * 不参与裁决（catalog model.api 权威）；custom-* 自建路径必填。
   * Phase 1926 Step D：ambient/oauth catalog preset 不再携带伪协议，故可选。
   */
  apiFormat?: ApiFormat;
  /** Phase 1926 Step D：认证装配类别（缺席按 api_key 处理，back-compat）。 */
  authProfile?: AuthProfile;
  /** ambient/oauth preset 的认证来源提示（CLI 交互/失败提示展示，不含 secret）。 */
  authHint?: string;
  defaultBaseUrl?: string;
  defaultModel?: string;
  /** Environment variable name for the API key (e.g. ANTHROPIC_API_KEY) */
  envVar?: string;
  /**
   * Phase 1925 Step C：preset → pi-ai catalog provider id 显式映射（G3 决策 3）。
   * 同名可直连 6 个；别名 5 个（gemini→google、grok→xai、moonshot→moonshotai、
   * openrouter-anthropic→openrouter）；无对应者（ollama、qwen-coder、custom-*）
   * = undefined → catalog 未命中走显式自建 Model + 启发式回退，
   * 不做名字相似度猜测。
   * Phase 1975：curated Anthropic preset 不设此字段（catalog api 权威会改写 wire）。
   */
  piAiProvider?: string;
  /**
   * Phase 1975 Step C：metadata-only catalog 查询（provider id）。只取
   * contextWindow/maxTokens/reasoning/input/cost 等元数据；实际 model id、
   * apiFormat、baseUrl 仍由 preset/配置决定（wire 不被 catalog 接管）。
   * 必须与 catalogModel 同时出现；不进 yaml schema、不由用户配置。
   */
  catalogProvider?: string;
  /** metadata-only catalog 查询的 model id（可与 wire model id 不同）。 */
  catalogModel?: string;
}

export const PRESETS: Record<string, ProviderPreset> = {
  'anthropic': {
    id: 'anthropic',
    displayName: 'Anthropic',
    apiFormat: 'anthropic',
    defaultBaseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-3-7-sonnet-20250219',
    envVar: 'ANTHROPIC_API_KEY',
    piAiProvider: 'anthropic',
  },
  'openai': {
    id: 'openai',
    displayName: 'OpenAI',
    apiFormat: 'openai',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o',
    envVar: 'OPENAI_API_KEY',
    piAiProvider: 'openai',
  },
  'deepseek': {
    id: 'deepseek',
    displayName: 'DeepSeek',
    apiFormat: 'anthropic',
    defaultBaseUrl: 'https://api.deepseek.com/anthropic',
    defaultModel: 'deepseek-flash[1m]',
    envVar: 'DEEPSEEK_API_KEY',
    // Phase 1973: piAiProvider removed — pi-ai deepseek catalog is OpenAI;
    // keeping it would make catalog hits override api to openai-completions
    // while baseUrl is /anthropic (协议权威冲突）。
    // Phase 1975 Step C：metadata-only——只取 catalog 元数据，wire 仍是 Anthropic preset。
    catalogProvider: 'deepseek',
    catalogModel: 'deepseek-flash', // 实际 wire model 仍是 deepseek-flash[1m]
  },
  'moonshot': {
    id: 'moonshot',
    displayName: 'Moonshot AI',
    apiFormat: 'openai',
    defaultBaseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'kimi-k2.5',
    envVar: 'MOONSHOT_API_KEY',
    piAiProvider: 'moonshotai',
  },
  'kimi': {
    id: 'kimi',
    displayName: 'Kimi (Coding)',
    apiFormat: 'anthropic',
    defaultBaseUrl: 'https://api.kimi.com/coding',
    defaultModel: 'k3-256k',
    envVar: 'KIMI_API_KEY',
    // Phase 1975 Step B：piAiProvider 移除（安全中间态）——pi-ai 1.4.0 的 kimi-coding
    // catalog 已变为 openai-completions + /coding/v1，保留会把 curated Anthropic wire 改成
    // OpenAI。Step C 以 catalogProvider/catalogModel metadata-only 方式接回元数据。
    catalogProvider: 'kimi-coding',
    catalogModel: 'k3-256k',
  },
  'minimax': {
    id: 'minimax',
    displayName: 'MiniMax',
    apiFormat: 'anthropic',
    defaultBaseUrl: 'https://api.minimax.io/anthropic',
    defaultModel: 'MiniMax-M3.1-Flash',
    envVar: 'MINIMAX_API_KEY',
    piAiProvider: 'minimax', // Anthropic catalog；M3.1-Flash miss 走自建 Anthropic
    // Phase 1975 Step C：metadata-only 优先——catalog 只供元数据，不接管 wire。
    catalogProvider: 'minimax',
    catalogModel: 'MiniMax-M3.1-Flash',
  },
  'gemini': {
    id: 'gemini',
    displayName: 'Google Gemini',
    apiFormat: 'gemini',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: 'gemini-2.5-pro-preview-03-25',
    envVar: 'GEMINI_API_KEY',
    piAiProvider: 'google',
  },
  'ollama': {
    id: 'ollama',
    displayName: 'Ollama',
    apiFormat: 'openai',
    defaultBaseUrl: 'http://localhost:11434/v1',
    defaultModel: 'llama3.1',
    envVar: 'OLLAMA_API_KEY',
  },
  'grok': {
    id: 'grok',
    displayName: 'xAI Grok',
    apiFormat: 'openai',
    defaultBaseUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-4',
    envVar: 'XAI_API_KEY',
    piAiProvider: 'xai',
  },
  'openrouter': {
    id: 'openrouter',
    displayName: 'OpenRouter',
    apiFormat: 'openai',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-4o',
    envVar: 'OPENROUTER_API_KEY',
    piAiProvider: 'openrouter',
  },
  'openrouter-anthropic': {
    id: 'openrouter-anthropic',
    displayName: 'OpenRouter (Anthropic format)',
    apiFormat: 'anthropic',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'anthropic/claude-sonnet-4-5',
    envVar: 'OPENROUTER_API_KEY',
    piAiProvider: 'openrouter',
  },
  'zai': {
    id: 'zai',
    displayName: 'Z.AI (Anthropic format)',
    apiFormat: 'anthropic',
    defaultBaseUrl: 'https://api.z.ai/api/anthropic',
    defaultModel: 'glm-5.3',
    envVar: 'ZAI_API_KEY',
    // Phase 1973: piAiProvider removed — pi-ai zai catalog is OpenAI; keeping it
    // caused catalog-hit models to use openai-completions against /api/anthropic.
    // Phase 1975 Step C：metadata-only——只取 catalog 元数据。
    catalogProvider: 'zai',
    catalogModel: 'glm-5.3',
  },
  // Phase 1973：curated Anthropic preset；setup 按序 probe 中国/国际/套餐候选。
  'qwen': {
    id: 'qwen',
    displayName: 'Qwen (Alibaba)',
    apiFormat: 'anthropic',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic',
    defaultModel: 'qwen3.8-max',
    envVar: 'DASHSCOPE_API_KEY',
    // no piAiProvider: pi-ai qwen catalogs are OpenAI; curated endpoint is Anthropic
    // Phase 1975 Step C：metadata-only——只取 catalog 元数据。
    catalogProvider: 'qwen-token-plan',
    catalogModel: 'qwen3.8-max',
  },
  'qwen-coder': {
    id: 'qwen-coder',
    displayName: 'Qwen Coder (Alibaba)',
    apiFormat: 'openai',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-coder-plus-latest',
    envVar: 'DASHSCOPE_API_KEY',
  },
  // ── Phase 1926 Step D：ambient / OAuth catalog preset（api_key 缺席合法） ──
  'amazon-bedrock': {
    id: 'amazon-bedrock',
    displayName: 'Amazon Bedrock',
    authProfile: 'ambient',
    authHint: 'AWS 凭证链（AWS_PROFILE / 默认链 / ECS / web identity）+ AWS_REGION；无需 api_key。',
    defaultModel: 'anthropic.claude-sonnet-4-6',
    piAiProvider: 'amazon-bedrock',
  },
  'google-vertex': {
    id: 'google-vertex',
    displayName: 'Google Vertex AI',
    authProfile: 'ambient',
    authHint: 'GOOGLE_CLOUD_API_KEY 或 ADC（GOOGLE_APPLICATION_CREDENTIALS / gcloud）+ GOOGLE_CLOUD_PROJECT/LOCATION；无需 api_key。',
    defaultModel: 'gemini-2.5-pro',
    piAiProvider: 'google-vertex',
  },
  'openai-codex': {
    id: 'openai-codex',
    displayName: 'OpenAI Codex (OAuth)',
    authProfile: 'oauth',
    authHint: '需先经 config provider login <label> 完成 OAuth 登录（纯 OAuth provider，api_key 无效）。',
    // Phase 1975 Step B：pi-ai 1.4.0 catalog 已无 gpt-5.5；取当前 catalog 命中值。
    defaultModel: 'gpt-6.1-sol',
    piAiProvider: 'openai-codex',
  },
  'github-copilot': {
    id: 'github-copilot',
    displayName: 'GitHub Copilot (OAuth)',
    authProfile: 'oauth',
    authHint: '需先经 config provider login <label> 完成 OAuth 登录（device code）。',
    // Phase 1975 Step B：pi-ai 1.4.0 catalog 已无 gpt-5.5；取当前 catalog 命中值。
    defaultModel: 'gpt-6.1-sol',
    piAiProvider: 'github-copilot',
  },
  'custom-anthropic': {
    id: 'custom-anthropic',
    displayName: 'Custom (Anthropic Format)',
    apiFormat: 'anthropic',
  },
  'custom-openai': {
    id: 'custom-openai',
    displayName: 'Custom (OpenAI Format)',
    apiFormat: 'openai',
  },
  'custom-gemini': {
    id: 'custom-gemini',
    displayName: 'Custom (Gemini Format)',
    apiFormat: 'gemini',
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

/** preset 认证装配类别（缺席 = api_key，Phase 1926 前语义）。 */
export function presetAuthProfile(preset: ProviderPreset): AuthProfile {
  return preset.authProfile ?? 'api_key';
}

/**
 * 该 preset 是否要求用户显式给 base URL：无默认 baseUrl 且无 catalog 权威
 * （piAiProvider）时才需要——catalog preset 的 endpoint 由 pi-ai catalog 裁决。
 */
export function presetRequiresBaseUrl(preset: ProviderPreset): boolean {
  return !preset.defaultBaseUrl && !preset.piAiProvider;
}
