/**
 * CLI-owned explicit LLM configuration methods.
 *
 * Normal setup never interprets legacy preset aliases. Every fixed method carries
 * its provider identity, wire protocol, endpoint, authentication and model facts;
 * legacy preset migration remains exclusively in L4's persistence read path.
 */
import { llmProviderCatalog, llmProviderConfigContract } from '../foundation/llm-provider/index.js';
import { DEFAULT_LLM_TIMEOUT_MS } from '../foundation/llm-orchestrator/index.js';
import type { LLMSetupDraft } from '../core/llm-configuration/index.js';

const { catalogModelKnown, isCatalogProvider, resolveCatalogIdentity } = llmProviderCatalog;
const { strictLLMProviderConfigSchema } = llmProviderConfigContract;
type ApiFormat = llmProviderCatalog.ApiFormat;
type AuthProfile = llmProviderCatalog.AuthProfile;

export type SetupProviderId =
  | 'deepseek'
  | 'kimi'
  | 'qwen'
  | 'glm'
  | 'minimax'
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'grok'
  | 'other';

export interface SetupThinkingDefaults {
  thinking?: boolean;
  thinkingMode?: 'adaptive' | 'enabled';
  thinkingEffort?: 'low' | 'medium' | 'high' | 'max';
  reasoningEffort?: 'low' | 'medium' | 'high' | 'max';
  thinkingBudgetTokens?: number;
  dropThinkingBlocks?: boolean;
}

export interface SetupProbeCandidate {
  readonly providerId: string;
  readonly apiFormat: ApiFormat;
  readonly authProfile: AuthProfile;
  readonly model: string;
  readonly baseUrl: string;
  readonly label: string;
}

export interface SetupProviderChoice {
  readonly id: SetupProviderId;
  readonly label: string;
  readonly description: string;
  readonly auth: 'api_key' | 'advanced';
  readonly providerId?: string;
  readonly apiFormat?: ApiFormat;
  readonly catalogApiFormat?: ApiFormat;
  readonly authProfile?: AuthProfile;
  readonly defaultBaseUrl?: string;
  readonly defaultModel?: string;
  readonly envVar?: string;
  readonly catalogProvider?: string;
  readonly catalogModel?: string;
  readonly thinkingDefaults?: SetupThinkingDefaults;
  readonly probeCandidates?: readonly SetupProbeCandidate[];
}

export function isCustomSetupChoice(choice: SetupProviderChoice): boolean {
  return choice.auth === 'advanced';
}

function candidate(
  providerId: string,
  model: string,
  baseUrl: string,
  label: string,
): SetupProbeCandidate {
  return { providerId, apiFormat: 'anthropic', authProfile: 'api_key', model, baseUrl, label };
}

const DEEPSEEK_MODEL = 'deepseek-flash[1m]';
const KIMI_MODEL = 'k3-256k';
const QWEN_MODEL = 'qwen3.8-max';
const GLM_MODEL = 'glm-5.3';
const MINIMAX_MODEL = 'MiniMax-M3.1-Flash';

const DEEPSEEK_CANDIDATES = [
  candidate('deepseek', DEEPSEEK_MODEL, 'https://api.deepseek.com/anthropic', 'DeepSeek (Anthropic)'),
] as const;
const KIMI_CANDIDATES = [
  candidate('kimi', KIMI_MODEL, 'https://api.kimi.com/coding', 'Kimi Code (CN)'),
  candidate('kimi', KIMI_MODEL, 'https://api.kimi.ai/coding', 'Kimi Code (Global)'),
  candidate('kimi', KIMI_MODEL, 'https://api.moonshot.cn/anthropic', 'Kimi Open (CN)'),
  candidate('kimi', KIMI_MODEL, 'https://api.moonshot.ai/anthropic', 'Kimi Open (Global)'),
] as const;
const QWEN_CANDIDATES = [
  candidate('qwen', QWEN_MODEL, 'https://dashscope.aliyuncs.com/apps/anthropic', 'Qwen (CN)'),
  candidate('qwen', QWEN_MODEL, 'https://dashscope-intl.aliyuncs.com/apps/anthropic', 'Qwen (Intl)'),
  candidate('qwen', QWEN_MODEL, 'https://dashscope-us.aliyuncs.com/apps/anthropic', 'Qwen (US)'),
  candidate('qwen', QWEN_MODEL, 'https://cn-hongkong.dashscope.aliyuncs.com/apps/anthropic', 'Qwen (HK)'),
  candidate('qwen', QWEN_MODEL, 'https://coding-intl.dashscope.aliyuncs.com/apps/anthropic', 'Qwen Coding Plan (Intl)'),
  candidate('qwen', QWEN_MODEL, 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic', 'Qwen Token Plan (Intl)'),
  candidate('qwen', QWEN_MODEL, 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic', 'Qwen Token Plan (CN)'),
] as const;
const GLM_CANDIDATES = [
  candidate('zai', GLM_MODEL, 'https://open.bigmodel.cn/api/anthropic', 'GLM Coding Plan (CN)'),
  candidate('zai', GLM_MODEL, 'https://api.z.ai/api/anthropic', 'GLM Coding Plan (Intl)'),
] as const;
const MINIMAX_CANDIDATES = [
  candidate('minimax', MINIMAX_MODEL, 'https://api.minimax.cn/anthropic', 'MiniMax (CN)'),
  candidate('minimax', MINIMAX_MODEL, 'https://api.minimax.io/anthropic', 'MiniMax (Intl)'),
] as const;

const ANTHROPIC_THINKING = { thinking: true, thinkingEffort: 'max' } as const;
const ADAPTIVE_THINKING = { thinkingMode: 'adaptive', thinkingEffort: 'max' } as const;
const REASONING_THINKING = { reasoningEffort: 'max' } as const;

/** Fixed order is part of the shared start/provider-add interface contract. */
export const SETUP_PROVIDER_CATALOG: readonly SetupProviderChoice[] = [
  {
    id: 'deepseek', label: 'DeepSeek', description: 'DeepSeek API', auth: 'api_key',
    providerId: 'deepseek', apiFormat: 'anthropic', authProfile: 'api_key',
    defaultBaseUrl: 'https://api.deepseek.com/anthropic', defaultModel: DEEPSEEK_MODEL,
    envVar: 'DEEPSEEK_API_KEY', catalogProvider: 'deepseek', catalogModel: 'deepseek-flash',
    thinkingDefaults: ANTHROPIC_THINKING, probeCandidates: DEEPSEEK_CANDIDATES,
  },
  {
    id: 'kimi', label: 'Kimi', description: 'Moonshot AI', auth: 'api_key',
    providerId: 'kimi', apiFormat: 'anthropic', authProfile: 'api_key',
    defaultBaseUrl: 'https://api.kimi.com/coding', defaultModel: KIMI_MODEL,
    envVar: 'KIMI_API_KEY', catalogProvider: 'kimi-coding', catalogModel: KIMI_MODEL,
    thinkingDefaults: ANTHROPIC_THINKING, probeCandidates: KIMI_CANDIDATES,
  },
  {
    id: 'qwen', label: 'Qwen', description: 'Qwen / DashScope', auth: 'api_key',
    providerId: 'qwen', apiFormat: 'anthropic', authProfile: 'api_key',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic', defaultModel: QWEN_MODEL,
    envVar: 'DASHSCOPE_API_KEY', catalogProvider: 'qwen-token-plan', catalogModel: QWEN_MODEL,
    thinkingDefaults: ANTHROPIC_THINKING, probeCandidates: QWEN_CANDIDATES,
  },
  {
    id: 'glm', label: 'GLM', description: 'Zhipu / Z.AI', auth: 'api_key',
    providerId: 'zai', apiFormat: 'anthropic', authProfile: 'api_key',
    defaultBaseUrl: 'https://api.z.ai/api/anthropic', defaultModel: GLM_MODEL,
    envVar: 'ZAI_API_KEY', catalogProvider: 'zai', catalogModel: GLM_MODEL,
    thinkingDefaults: ANTHROPIC_THINKING, probeCandidates: GLM_CANDIDATES,
  },
  {
    id: 'minimax', label: 'MiniMax', description: 'MiniMax API', auth: 'api_key',
    providerId: 'minimax', apiFormat: 'anthropic', authProfile: 'api_key',
    defaultBaseUrl: 'https://api.minimax.io/anthropic', defaultModel: MINIMAX_MODEL,
    envVar: 'MINIMAX_API_KEY', catalogProvider: 'minimax', catalogModel: MINIMAX_MODEL,
    thinkingDefaults: { ...ADAPTIVE_THINKING, dropThinkingBlocks: true },
    probeCandidates: MINIMAX_CANDIDATES,
  },
  {
    id: 'openai', label: 'OpenAI', description: 'OpenAI API', auth: 'api_key',
    providerId: 'openai', apiFormat: 'openai', catalogApiFormat: 'openai-responses', authProfile: 'api_key',
    defaultBaseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o', envVar: 'OPENAI_API_KEY',
    thinkingDefaults: REASONING_THINKING,
  },
  {
    id: 'anthropic', label: 'Anthropic', description: 'Anthropic Claude API', auth: 'api_key',
    providerId: 'anthropic', apiFormat: 'anthropic', authProfile: 'api_key',
    defaultBaseUrl: 'https://api.anthropic.com', defaultModel: 'claude-3-7-sonnet-20250219',
    envVar: 'ANTHROPIC_API_KEY', thinkingDefaults: ADAPTIVE_THINKING,
  },
  {
    id: 'gemini', label: 'Gemini', description: 'Google Gemini API', auth: 'api_key',
    providerId: 'google', apiFormat: 'gemini', authProfile: 'api_key',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: 'gemini-2.5-pro-preview-03-25', envVar: 'GEMINI_API_KEY',
    thinkingDefaults: REASONING_THINKING,
  },
  {
    id: 'grok', label: 'Grok', description: 'xAI Grok API', auth: 'api_key',
    providerId: 'xai', apiFormat: 'openai', catalogApiFormat: 'openai-responses', authProfile: 'api_key',
    defaultBaseUrl: 'https://api.x.ai/v1', defaultModel: 'grok-4', envVar: 'XAI_API_KEY',
    thinkingDefaults: REASONING_THINKING,
  },
  {
    id: 'other', label: 'Other', description: 'Custom OpenAI/Anthropic/Gemini-compatible endpoint',
    auth: 'advanced', thinkingDefaults: ADAPTIVE_THINKING,
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

/** UI draft: explicit provider facts only; commit labels/targets stay outside. */
export interface ExplicitSetupDraft {
  readonly choice: SetupProviderChoice;
  readonly providerId: string;
  readonly apiFormat: ApiFormat;
  readonly authProfile: AuthProfile;
  readonly apiKey?: string;
  readonly model: string;
  readonly baseUrl?: string;
}

export function createExplicitSetupDraft(
  choice: SetupProviderChoice,
  input: {
    apiKey?: string;
    model: string;
    baseUrl?: string;
    apiFormat?: ApiFormat;
    authProfile?: AuthProfile;
  },
): ExplicitSetupDraft {
  const apiFormat = isCustomSetupChoice(choice) ? input.apiFormat : choice.apiFormat;
  if (!apiFormat) throw new Error(`API format is required for ${choice.label}`);
  const providerId = isCustomSetupChoice(choice) ? `custom:${apiFormat}` : choice.providerId;
  if (!providerId) throw new Error(`Provider identity is required for ${choice.label}`);
  return {
    choice,
    providerId,
    apiFormat,
    authProfile: input.authProfile ?? choice.authProfile ?? 'api_key',
    ...(input.apiKey !== undefined && { apiKey: input.apiKey }),
    model: input.model,
    ...(input.baseUrl !== undefined && { baseUrl: input.baseUrl }),
  };
}

function resolvedThinking(choice: SetupProviderChoice, model: string) {
  const defaults = choice.thinkingDefaults;
  if (!defaults) return undefined;
  if (!choice.catalogProvider && choice.providerId && isCatalogProvider(choice.providerId)
    && catalogModelKnown(choice.providerId, model)) {
    const resolution = resolveCatalogIdentity({
      name: choice.label,
      model,
      apiFormat: choice.catalogApiFormat ?? choice.apiFormat,
      piAiProvider: choice.providerId,
    }, 'provider_id');
    if (resolution.metadata?.reasoning === false) return undefined;
  }
  return {
    ...(defaults.thinking !== undefined && { thinking: defaults.thinking }),
    ...(defaults.thinkingMode !== undefined && { thinking_mode: defaults.thinkingMode }),
    ...(defaults.thinkingEffort !== undefined && { thinking_effort: defaults.thinkingEffort }),
    ...(defaults.reasoningEffort !== undefined && { reasoning_effort: defaults.reasoningEffort }),
    ...(defaults.thinkingBudgetTokens !== undefined && { thinking_budget_tokens: defaults.thinkingBudgetTokens }),
    ...(defaults.dropThinkingBlocks !== undefined && { drop_thinking_blocks: defaults.dropThinkingBlocks }),
  };
}

export function describeEffectiveThinking(
  choice: SetupProviderChoice,
  model: string | undefined,
): string | undefined {
  if (!model) return undefined;
  const defaults = resolvedThinking(choice, model);
  if (!defaults) return undefined;
  if (defaults.reasoning_effort) return `reasoning ${defaults.reasoning_effort}`;
  const mode = defaults.thinking_mode ?? (defaults.thinking ? 'enabled' : 'adaptive');
  const effort = defaults.thinking_effort ?? 'high';
  return `${mode} (${effort})`;
}

export function makeExplicitSetupProvider(input: ExplicitSetupDraft & { label?: string }) {
  const { choice } = input;
  const metadataOnly = choice.catalogProvider !== undefined;
  const catalogDirect = !metadataOnly && isCatalogProvider(input.providerId)
    && catalogModelKnown(input.providerId, input.model);
  const providerId = metadataOnly || catalogDirect || input.providerId.startsWith('custom:')
    ? input.providerId
    : `custom:${choice.id}`;
  const baseUrl = input.baseUrl ?? choice.defaultBaseUrl;
  return strictLLMProviderConfigSchema.parse({
    provider_id: providerId,
    api_format: catalogDirect ? choice.catalogApiFormat ?? input.apiFormat : input.apiFormat,
    auth_profile: input.authProfile,
    ...(input.label !== undefined && { label: input.label }),
    ...(input.apiKey !== undefined && { api_key: input.apiKey }),
    model: input.model,
    ...(baseUrl !== undefined && { base_url: baseUrl }),
    ...(choice.catalogProvider !== undefined && { catalog_provider: choice.catalogProvider }),
    ...(choice.catalogModel !== undefined && { catalog_model: choice.catalogModel }),
    ...resolvedThinking(choice, input.model),
    temperature: 0.7,
    timeout_ms: DEFAULT_LLM_TIMEOUT_MS,
  });
}

export function makeExplicitSetupDraft(
  input: ExplicitSetupDraft,
  target?: { label?: string },
): LLMSetupDraft {
  const provider = makeExplicitSetupProvider({ ...input, ...(target?.label !== undefined && { label: target.label }) });
  const candidates = input.choice.probeCandidates;
  // An explicitly supplied endpoint is authoritative and disables directory probing.
  if (input.baseUrl !== undefined || !candidates?.length) return { provider };
  return {
    provider,
    candidates: candidates.map((candidate, index) => {
      const config = makeExplicitSetupProvider({
        ...input,
        providerId: candidate.providerId,
        apiFormat: candidate.apiFormat,
        authProfile: candidate.authProfile,
        baseUrl: candidate.baseUrl,
        ...(target?.label !== undefined && { label: target.label }),
      });
      return { identity: `${config.provider_id}#${index + 1}`, config };
    }),
  };
}
