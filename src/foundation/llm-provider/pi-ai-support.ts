/**
 * @module L1.LLMProvider.PiAi
 *
 * pi-ai 运行时装载与 Model 解析（Phase 1925 Step C）。
 *
 * - pi-ai 只经动态 import 触达（CJS 产物无 require 条件——静态 import 必炸，
 *   设计稿 K7）；模块级 promise 缓存，装载失败清缓存以便下次重试。
 * - 协议显式：chestnut `apiFormat` → pi-ai api 映射是唯一协议裁决；catalog
 *   命中时以 catalog model 的 api 为权威；绝不按 model/baseUrl 猜协议。
 * - api 实现表刻意收窄（对齐 dsh 先例）：四族 HTTP 协议（openai-completions /
 *   openai-responses / anthropic-messages / google-generative-ai）可由
 *   api_key + baseUrl 完整描述；bedrock/vertex/azure/codex 等需要
 *   SigV4/ADC/OAuth 的族不在本配置形状内，命中即 loud 拒绝（不静默退化）。
 */

import type * as PiAi from '@earendil-works/pi-ai';
import { LLMError } from './errors.js';
import { resolveContextWindow } from './model-context-windows.js';
import type { ProviderConfig } from './types.js';
import type { ApiFormat } from './presets.js';

/** pi-ai 动态装载面（主入口 + catalog + 四族 lazy api）。 */
export interface PiAiRuntime {
  createModels: typeof PiAi.createModels;
  createProvider: typeof PiAi.createProvider;
  getBuiltinProviders: () => string[];
  getBuiltinModels: (provider: string) => PiAi.Model<PiAi.Api>[];
  /** 支持的 pi-ai api → lazy 实现工厂。 */
  apis: Record<string, () => PiAi.ProviderStreams>;
}

let runtimePromise: Promise<PiAiRuntime> | undefined;

/** 动态装载 pi-ai（模块级缓存；失败清缓存不缓存 rejection）。 */
export function loadPiAiRuntime(): Promise<PiAiRuntime> {
  runtimePromise ??= (async (): Promise<PiAiRuntime> => {
    const [main, catalog, anthropic, openaiComp, openaiResp, google] = await Promise.all([
      import('@earendil-works/pi-ai'),
      import('@earendil-works/pi-ai/providers/all'),
      import('@earendil-works/pi-ai/api/anthropic-messages.lazy'),
      import('@earendil-works/pi-ai/api/openai-completions.lazy'),
      import('@earendil-works/pi-ai/api/openai-responses.lazy'),
      import('@earendil-works/pi-ai/api/google-generative-ai.lazy'),
    ]);
    return {
      createModels: main.createModels,
      createProvider: main.createProvider,
      getBuiltinProviders: catalog.getBuiltinProviders as unknown as () => string[],
      getBuiltinModels: catalog.getBuiltinModels as unknown as (provider: string) => PiAi.Model<PiAi.Api>[],
      apis: {
        'anthropic-messages': anthropic.anthropicMessagesApi,
        'openai-completions': openaiComp.openAICompletionsApi,
        'openai-responses': openaiResp.openAIResponsesApi,
        'google-generative-ai': google.googleGenerativeAIApi,
      },
    };
  })().catch((err) => {
    runtimePromise = undefined;
    throw err;
  });
  return runtimePromise;
}

/** chestnut apiFormat → pi-ai api（唯一协议裁决点；显式、不猜测）。 */
export const API_FORMAT_TO_PI_AI_API: Readonly<Record<ApiFormat, string>> = {
  anthropic: 'anthropic-messages',
  openai: 'openai-completions',
  gemini: 'google-generative-ai',
};

/** 自建 Model 缺省 maxTokens（catalog 未命中、用户未配 max_tokens 时）。 */
const CUSTOM_MODEL_DEFAULT_MAX_TOKENS = 65_536;

export interface ResolvedPiAiModel {
  model: PiAi.Model<PiAi.Api>;
  /** true = catalog 命中（能力元数据来自 pi-ai 目录）；false = 显式自建。 */
  fromCatalog: boolean;
}

/**
 * 解析 ProviderConfig → pi-ai Model。
 * 1. `config.piAiProvider` 命中 catalog provider 且 model id 命中 → catalog model
 *    （api/baseUrl/能力元数据权威；config.baseUrl 显式给出且不同时覆盖 baseUrl）；
 * 2. 否则自建 Model 字面量：api 由 apiFormat 显式映射，baseUrl 必填（缺失 loud），
 *    contextWindow 走 resolveContextWindow（catalog/启发式回退）。
 */
export function resolvePiAiModel(runtime: PiAiRuntime, config: ProviderConfig): ResolvedPiAiModel {
  if (config.piAiProvider) {
    if (runtime.getBuiltinProviders().includes(config.piAiProvider)) {
      const hit = runtime
        .getBuiltinModels(config.piAiProvider)
        .find((m) => m.id === config.model);
      if (hit) {
        const overridden =
          config.baseUrl && config.baseUrl !== hit.baseUrl
            ? { ...hit, baseUrl: config.baseUrl }
            : hit;
        return { model: overridden as PiAi.Model<PiAi.Api>, fromCatalog: true };
      }
    }
  }

  const api = API_FORMAT_TO_PI_AI_API[config.apiFormat];
  const baseUrl = config.baseUrl;
  if (!baseUrl) {
    throw new LLMError(
      `Provider "${config.name}": base URL is required for models outside the pi-ai catalog ` +
      `(model="${config.model}", api="${api}")`,
      { provider: config.name, field: 'baseUrl' },
    );
  }
  const model: PiAi.Model<PiAi.Api> = {
    id: config.model,
    name: config.model,
    api: api as PiAi.Api,
    provider: config.piAiProvider ?? config.name,
    baseUrl,
    reasoning: config.thinking === true || config.reasoningEffort !== undefined,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: resolveContextWindow(config.piAiProvider ?? config.name, config.model),
    maxTokens: config.maxTokens ?? CUSTOM_MODEL_DEFAULT_MAX_TOKENS,
  };
  return { model, fromCatalog: false };
}

export interface PiAiEndpoint {
  models: PiAi.Models;
  model: PiAi.Model<PiAi.Api>;
  fromCatalog: boolean;
}

/**
 * 构造 adapter 实例级 endpoint：单 model 的 Models 集合。
 * apiKey 一律经 per-request `options.apiKey` override 传入（dsh 同形）——provider
 * 声明 apiKey auth 方法使 override 生效；值本身只在请求期出现，不落在构造态。
 * catalog model 的 api 不在支持表内 → loud LLMError（不静默换协议）。
 */
export async function createPiAiEndpoint(config: ProviderConfig): Promise<PiAiEndpoint> {
  const runtime = await loadPiAiRuntime();
  const { model, fromCatalog } = resolvePiAiModel(runtime, config);
  const apiFactory = runtime.apis[model.api as string];
  if (!apiFactory) {
    throw new LLMError(
      `Provider "${config.name}": pi-ai api "${String(model.api)}" (model "${model.id}") is not supported ` +
      `by this credential shape (supported: ${Object.keys(runtime.apis).join(', ')}). ` +
      `Providers needing SigV4/ADC/OAuth are out of scope (Phase 1925 Step C registered boundary).`,
      { provider: config.name, api: String(model.api) },
    );
  }
  const provider = runtime.createProvider({
    id: model.provider,
    name: config.name,
    baseUrl: model.baseUrl,
    auth: {
      apiKey: {
        name: `${config.name} API key`,
        resolve: ({ credential }) =>
          Promise.resolve({
            auth: credential?.key === undefined ? {} : { apiKey: credential.key },
            source: 'chestnut-config',
          }),
      },
    },
    models: [model],
    api: apiFactory(),
  });
  const models = runtime.createModels();
  models.setProvider(provider);
  return { models, model, fromCatalog };
}
