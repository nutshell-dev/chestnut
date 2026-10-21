/**
 * @module L1.LLMProvider.PiAi.Runtime
 *
 * pi-ai 运行时动态装载（Phase 1925 Step C；Phase 1964 Step B 自 pi-ai-support.ts 拆出）。
 *
 * pi-ai 只经动态 import 触达（CJS 产物无 require 条件——静态 import 必炸，
 * 设计稿 K7）；模块级 promise 缓存，装载失败清缓存以便下次重试。
 * 全部 10 个 catalog api 的 lazy 工厂均注册（inventory 门禁测试逐一对账；
 * 缺失即红灯，不再 loud "out of scope"）。
 */

import type * as PiAi from '@earendil-works/pi-ai';

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
