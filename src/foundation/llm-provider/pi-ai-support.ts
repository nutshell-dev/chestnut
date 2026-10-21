/**
 * @module L1.LLMProvider.PiAi
 *
 * pi-ai 运行时装载与 Model 解析（Phase 1925 Step C；Phase 1926 Step D 全 provider 覆盖）。
 *
 * - pi-ai 只经动态 import 触达（CJS 产物无 require 条件——静态 import 必炸，
 *   设计稿 K7）；模块级 promise 缓存，装载失败清缓存以便下次重试。
 * - 协议显式：chestnut `apiFormat` → pi-ai api 映射是自建 Model 路径的唯一协议裁决；
 *   catalog 命中时以 catalog model 的 api 为权威；绝不按 model/baseUrl 猜协议。
 * - Phase 1926 Step D：catalog 命中走 pi-ai `builtinProviders()` —— 每个内建
 *   provider 自带完整 auth（api_key env/ambient AWS 链/ADC/OAuth refresh）与
 *   lazy api 绑定，chestnut 不自建 provider 不伪造 auth；stored credential 经
 *   pi-ai-credentials.ts 的 CredentialStore 桥接用户级 Credentials owner。
 *   自建 Model 路径（ollama/custom-*）保留窄表三族（anthropic/openai/gemini）
 *   HTTP 协议 + 单 apiKey auth。
 * - 全部 10 个 catalog api 的 lazy 工厂均注册（inventory 门禁测试逐一对账；
 *   缺失即红灯，不再 loud "out of scope"）。
 */

import type * as PiAi from '@earendil-works/pi-ai';
import { LLMError } from './errors.js';
import { PROVIDER_INVENTORY } from './provider-inventory.generated.js';
import type { PiAiCredentialStore } from './pi-ai-credentials.js';
import { resolveContextWindow } from './model-context-windows.js';
import type { ProviderConfig } from './types.js';
import type { ApiFormat } from './presets.js';

/** pi-ai 动态装载面（主入口 + catalog + 全部 catalog api 的 lazy 工厂）。 */
export interface PiAiRuntime {
  createModels: typeof PiAi.createModels;
  createProvider: typeof PiAi.createProvider;
  getBuiltinProviders: () => string[];
  getBuiltinModels: (provider: string) => PiAi.Model<PiAi.Api>[];
  /** 全部内建 provider（新实例；自带完整 auth 与 lazy api 绑定）。 */
  builtinProviders: () => PiAi.Provider[];
  /** catalog api → lazy 实现工厂（自建 Model 路径用；inventory 门禁对账）。 */
  apis: Record<string, () => PiAi.ProviderStreams>;
  /** pi-ai 官方 context overflow 判定（error/silent/length 三态，Phase 1960）。 */
  isContextOverflow: typeof PiAi.isContextOverflow;
}

let runtimePromise: Promise<PiAiRuntime> | undefined;

/** 动态装载 pi-ai（模块级缓存；失败清缓存不缓存 rejection）。 */
export function loadPiAiRuntime(): Promise<PiAiRuntime> {
  runtimePromise ??= (async (): Promise<PiAiRuntime> => {
    const [main, catalog, anthropic, azure, bedrock, google, vertex, mistral, codex, openaiComp, openaiResp, piMessages] = await Promise.all([
      import('@earendil-works/pi-ai'),
      import('@earendil-works/pi-ai/providers/all'),
      import('@earendil-works/pi-ai/api/anthropic-messages.lazy'),
      import('@earendil-works/pi-ai/api/azure-openai-responses.lazy'),
      import('@earendil-works/pi-ai/api/bedrock-converse-stream.lazy'),
      import('@earendil-works/pi-ai/api/google-generative-ai.lazy'),
      import('@earendil-works/pi-ai/api/google-vertex.lazy'),
      import('@earendil-works/pi-ai/api/mistral-conversations.lazy'),
      import('@earendil-works/pi-ai/api/openai-codex-responses.lazy'),
      import('@earendil-works/pi-ai/api/openai-completions.lazy'),
      import('@earendil-works/pi-ai/api/openai-responses.lazy'),
      import('@earendil-works/pi-ai/api/pi-messages.lazy'),
    ]);
    return {
      createModels: main.createModels,
      createProvider: main.createProvider,
      getBuiltinProviders: catalog.getBuiltinProviders as unknown as () => string[],
      getBuiltinModels: catalog.getBuiltinModels as unknown as (provider: string) => PiAi.Model<PiAi.Api>[],
      builtinProviders: catalog.builtinProviders as unknown as () => PiAi.Provider[],
      apis: {
        'anthropic-messages': anthropic.anthropicMessagesApi,
        'azure-openai-responses': azure.azureOpenAIResponsesApi,
        'bedrock-converse-stream': bedrock.bedrockConverseStreamApi,
        'google-generative-ai': google.googleGenerativeAIApi,
        'google-vertex': vertex.googleVertexApi,
        'mistral-conversations': mistral.mistralConversationsApi,
        'openai-codex-responses': codex.openAICodexResponsesApi,
        'openai-completions': openaiComp.openAICompletionsApi,
        'openai-responses': openaiResp.openAIResponsesApi,
        'pi-messages': piMessages.piMessagesApi,
      },
      isContextOverflow: main.isContextOverflow,
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

  // 自建 Model 路径：apiFormat 是唯一协议裁决（显式、不猜测）；catalog preset
  // 未命中 model 时必须显式给 apiFormat + baseUrl。
  const api = config.apiFormat ? API_FORMAT_TO_PI_AI_API[config.apiFormat] : undefined;
  if (!api) {
    throw new LLMError(
      `Provider "${config.name}": apiFormat is required for models outside the pi-ai catalog ` +
      `(model="${config.model}", piAiProvider="${config.piAiProvider ?? 'none'}")`,
      { provider: config.name, field: 'apiFormat' },
    );
  }
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

export interface PiAiEndpointOptions {
  /** 测试注入：pi-ai auth 环境解析上下文（缺省 = process.env + node fs）。 */
  authContext?: PiAi.AuthContext;
  /**
   * Phase 1927 Step E：CredentialStore 实例依赖（装配根固定创建注入；
   * backend 在实例生命周期内不漂移）。OAuth-capable provider 缺 store → loud
   * （refresh 轮换的 token 无处持久化，不得静默丢凭证）。
   */
  credentials?: PiAiCredentialStore;
}

/**
 * 构造 adapter 实例级 endpoint：单 model 的 Models 集合。
 *
 * catalog 命中（Phase 1926 Step D）：复用 pi-ai `builtinProviders()` 的内建
 * provider —— 完整 auth（api_key env / ambient AWS 链 / ADC / OAuth refresh）
 * 与 lazy api 绑定由 pi-ai 原生装配；stored credential 经 CredentialStore 桥接
 * 用户级 Credentials owner；config.apiKey 仍经 per-request override 注入（${REF}
 * 解析链不变）。OAuth-only provider 收到 config.apiKey → loud 拒绝（pi-ai 会静默
 * 忽略该 override，不得让用户误以为生效）。
 *
 * 自建 Model 路径：单 apiKey auth 的自定义 provider（apiKey 一律经 per-request
 * `options.apiKey` override 传入——值只在请求期出现，不落在构造态）。
 */
export async function createPiAiEndpoint(
  config: ProviderConfig,
  options?: PiAiEndpointOptions,
): Promise<PiAiEndpoint> {
  const runtime = await loadPiAiRuntime();
  const { model, fromCatalog } = resolvePiAiModel(runtime, config);

  if (fromCatalog) {
    const provider = runtime.builtinProviders().find((p) => p.id === model.provider);
    if (!provider) {
      throw new LLMError(
        `Provider "${config.name}": pi-ai builtin provider "${model.provider}" not found ` +
        `(catalog model "${model.id}")`,
        { provider: config.name, api: String(model.api) },
      );
    }
    if (config.apiKey && !provider.auth.apiKey) {
      throw new LLMError(
        `Provider "${config.name}": "${model.provider}" is OAuth-only — configured api_key has no effect. ` +
        `Remove api_key from the config and complete the interactive provider login instead.`,
        { provider: config.name, field: 'apiKey' },
      );
    }
    // Phase 1927 Step E：OAuth-capable provider 必须有装配注入的 CredentialStore
    // （否则 refresh 轮换 token 静默丢失——pi-ai 缺省 InMemoryCredentialStore 不持久化）
    if (!options?.credentials && PROVIDER_INVENTORY[model.provider]?.auth.oauth) {
      throw new LLMError(
        `Provider "${config.name}": "${model.provider}" supports OAuth stored credentials but no ` +
        `credential store was injected (assembly must create and inject one — see pi-ai-credentials.ts)`,
        { provider: config.name, field: 'credentialStore' },
      );
    }
    const models = runtime.createModels({
      ...(options?.credentials && { credentials: options.credentials }),
      ...(options?.authContext && { authContext: options.authContext }),
    });
    models.setProvider(provider);
    return { models, model, fromCatalog };
  }

  const apiFactory = runtime.apis[model.api as string];
  if (!apiFactory) {
    // 自建路径 api 由 apiFormat 显式映射（三族 anthropic/openai/gemini HTTP 协议）；理论不可达，防御 loud。
    throw new LLMError(
      `Provider "${config.name}": pi-ai api "${String(model.api)}" (model "${model.id}") has no ` +
      `registered lazy factory (registered: ${Object.keys(runtime.apis).join(', ')})`,
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
