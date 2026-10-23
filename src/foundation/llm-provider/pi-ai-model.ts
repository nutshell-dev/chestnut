/**
 * @module L1.LLMProvider.PiAi.Model
 *
 * ProviderConfig → pi-ai Model 解析（Phase 1925 Step C；Phase 1964 Step B 自
 * pi-ai-support.ts 拆出）。
 *
 * 协议显式：chestnut `apiFormat` → pi-ai api 映射是自建 Model 路径的唯一协议裁决；
 * catalog 命中时以 catalog model 的 api 为权威；绝不按 model/baseUrl 猜协议。
 * 自建 Model 路径（ollama/custom-*）保留窄表三族（anthropic/openai/gemini）
 * HTTP 协议。
 */

import type * as PiAi from '@earendil-works/pi-ai';
import { LLMError } from './errors.js';
import { resolveContextWindow } from './model-context-windows.js';
import type { ProviderConfig } from './types.js';
import type { ApiFormat } from './presets.js';
import type { PiAiRuntime } from './pi-ai-runtime.js';

/** chestnut apiFormat → pi-ai api（唯一协议裁决点；显式、不猜测）。 */
export const API_FORMAT_TO_PI_AI_API: Readonly<Record<ApiFormat, string>> = {
  anthropic: 'anthropic-messages',
  openai: 'openai-completions',
  gemini: 'google-generative-ai',
};

/** 自建 Model 缺省 maxTokens（catalog 未命中、用户未配 max_tokens 时）。 */
const CUSTOM_MODEL_DEFAULT_MAX_TOKENS = 65_536;

/**
 * Phase 1979：自建 / metadata-only Model 的 reasoning 能力派生。
 * mode/effort 显式给出即视为 reasoning-capable（`thinking: false` 只是运行时关闭，
 * 不否定模型能力）；实际是否发送 reasoning 由 adapter.reasoningLevel 裁决。
 */
function reasoningEnabled(config: ProviderConfig): boolean {
  return config.thinking === true
    || config.thinkingMode !== undefined
    || config.thinkingEffort !== undefined
    || config.reasoningEffort !== undefined;
}

export interface ResolvedPiAiModel {
  model: PiAi.Model<PiAi.Api>;
  /** true = catalog 命中（能力元数据来自 pi-ai 目录）；false = 显式自建。 */
  fromCatalog: boolean;
}

/**
 * 解析 ProviderConfig → pi-ai Model。
 * 0. Phase 1975 Step C：`catalogProvider` + `catalogModel` 同时存在 → metadata-only
 *    路径：catalog 只供 contextWindow/maxTokens/reasoning/input/cost 元数据，
 *    wire（model.id/api/baseUrl）由 preset/配置决定，`fromCatalog: false`；
 * 1. `config.piAiProvider` 命中 catalog provider 且 model id 命中 → catalog model
 *    （api/baseUrl/能力元数据权威；config.baseUrl 显式给出且不同时覆盖 baseUrl）；
 * 2. 否则自建 Model 字面量：api 由 apiFormat 显式映射，baseUrl 必填（缺失 loud），
 *    contextWindow 走 resolveContextWindow（catalog/启发式回退）。
 */
export function resolvePiAiModel(runtime: PiAiRuntime, config: ProviderConfig): ResolvedPiAiModel {
  // Phase 1975 Step C：metadata-only——catalog 元数据与 wire 分离。
  // 不得返回 fromCatalog: true（createPiEndpoint 会接管 api/baseUrl）；
  // model.id 必须是 config.model（实际 wire model），不是 catalogModel。
  if (config.catalogProvider && config.catalogModel) {
    const metadata = runtime
      .getBuiltinModels(config.catalogProvider)
      .find((m) => m.id === config.catalogModel);
    const api = config.apiFormat ? API_FORMAT_TO_PI_AI_API[config.apiFormat] : undefined;
    if (!api || !config.baseUrl) {
      // curated preset 必须显式 api/baseUrl——metadata-only 不提供 wire 兜底
      throw new LLMError(
        `Provider "${config.name}": catalog metadata mapping (catalogProvider="${config.catalogProvider}", ` +
        `catalogModel="${config.catalogModel}") requires explicit apiFormat and baseUrl on the preset/config ` +
        `(apiFormat="${config.apiFormat ?? 'none'}", baseUrl="${config.baseUrl ?? 'none'}")`,
        { provider: config.name, field: 'catalogProvider' },
      );
    }
    // Phase 1979：只补 thinking 能力元数据（adaptive/level map），不整包拷贝 compat、
    // 不接管 wire（api/baseUrl/id 仍由 preset/config 决定）。
    const metadataCompat = metadata?.compat as { forceAdaptiveThinking?: boolean } | undefined;
    const model: PiAi.Model<PiAi.Api> = {
      id: config.model,
      name: config.model,
      api: api as PiAi.Api,
      provider: config.piAiProvider ?? config.name,
      baseUrl: config.baseUrl,
      reasoning: metadata?.reasoning ?? reasoningEnabled(config),
      input: metadata?.input ?? ['text'],
      cost: metadata?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: metadata?.contextWindow
        ?? resolveContextWindow(config.piAiProvider ?? config.name, config.model),
      maxTokens: config.maxTokens ?? metadata?.maxTokens ?? CUSTOM_MODEL_DEFAULT_MAX_TOKENS,
      ...(metadataCompat?.forceAdaptiveThinking === true && {
        compat: { forceAdaptiveThinking: true } as unknown as PiAi.Model<PiAi.Api>['compat'],
      }),
      ...(metadata?.thinkingLevelMap !== undefined && {
        thinkingLevelMap: metadata.thinkingLevelMap,
      }),
    };
    return { model, fromCatalog: false };
  }

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
    reasoning: reasoningEnabled(config),
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: resolveContextWindow(config.piAiProvider ?? config.name, config.model),
    maxTokens: config.maxTokens ?? CUSTOM_MODEL_DEFAULT_MAX_TOKENS,
  };
  return { model, fromCatalog: false };
}
