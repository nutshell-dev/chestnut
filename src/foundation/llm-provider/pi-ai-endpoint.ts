/**
 * @module L1.LLMProvider.PiAi.Endpoint
 *
 * adapter 实例级 endpoint 装配（auth/catalog/credential；Phase 1926 Step D /
 * Phase 1927 Step E；Phase 1964 Step B 自 pi-ai-support.ts 拆出）。
 *
 * - catalog 命中走 pi-ai `builtinProviders()` —— 每个内建 provider 自带完整
 *   auth（api_key env/ambient AWS 链/ADC/OAuth refresh）与 lazy api 绑定，
 *   chestnut 不自建 provider 不伪造 auth；stored credential 经
 *   pi-ai-credentials.ts 的 CredentialStore 桥接用户级 Credentials owner。
 * - 自建 Model 路径（ollama/custom-*）：单 apiKey auth 的自定义 provider。
 */

import type * as PiAi from '@earendil-works/pi-ai';
import { LLMError } from './errors.js';
import { PROVIDER_INVENTORY } from './provider-inventory.generated.js';
import type { PiAiCredentialStore } from './pi-ai-credentials.js';
import type { ProviderConfig } from './types.js';
import { loadPiAiRuntime } from './pi-ai-runtime.js';
import { resolvePiAiModel } from './pi-ai-model.js';

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
