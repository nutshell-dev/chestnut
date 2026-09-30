/**
 * @module L1.LLMProvider.PiAi
 *
 * PiAiAdapter —— pi-ai 作为唯一 L1 provider 实现（Phase 1925 Step C）。
 *
 * 对外保持既有 ProviderAdapter 契约（call/stream/chunk 语义/typed errors）；
 * pi-ai 只在模块内部可见（动态 import，见 pi-ai-support.ts）。职责四件
 * （设计稿 D1）：wire 映射（pi-ai-wire.ts）、事件翻译（pi-ai-events.ts）、
 * 失败构造（pi-ai-errors.ts）、配置语义（apiFormat 显式协议 + catalog/自建 Model）。
 *
 * 中止/超时语义对齐旧 fetch 适配器：外部 signal aborted → ExternalAbortError；
 * 内部超时（withCombinedAbortSignal 定时器）→ LLMTimeoutError；
 * 流传输层非 LLMError 异常 → LLMNetworkError。
 * output budget：OpenAI 族 400 budget 文本可解析时自动调低 maxTokens 重试一次
 * （stream 已产出 chunk 则不重试）——沿用旧 anthropic 适配器纪律。
 */

import type * as PiAi from '@earendil-works/pi-ai';
import type {
  LLMCallOptions,
  LLMResponse,
  ProviderAdapter,
  ProviderConfig,
  ProviderStreamChunk,
} from './types.js';
import {
  LLMError,
  LLMEmptyResponseError,
  LLMNetworkError,
  LLMOutputBudgetExceededError,
  LLMTimeoutError,
} from './errors.js';
import { makeToolUseId } from './tool-use-id.js';
import {
  classifyFetchAbortError,
  ExternalAbortError,
  makeExternalAbortError,
  withCombinedAbortSignal,
} from './abort-helper.js';
import { createPiAiEndpoint, type PiAiEndpoint } from './pi-ai-support.js';
import type { PiAiCredentialStore } from './pi-ai-credentials.js';
import { buildPiAiContext } from './pi-ai-wire.js';
import {
  createEventTranslationState,
  mapStopReason,
  mapUsage,
  translatePiAiEvent,
} from './pi-ai-events.js';
import {
  classifyCapturedHttpError,
  classifyTextualError,
  createCapturingFetch,
  isGoogleFamilyApi,
  type HttpErrorCapture,
} from './pi-ai-errors.js';

/** pi-ai ThinkingLevel（streamSimple 的 reasoning 档位）。 */
type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Phase 1927 Step E：adapter 实例级注入面（装配根传入固定 CredentialStore）。 */
export interface PiAiAdapterOptions {
  credentialStore?: PiAiCredentialStore;
}

export class PiAiAdapter implements ProviderAdapter {
  readonly name: string;
  readonly model: string;

  /** Set by LLMOrchestratorImpl（观测通道；pi-ai 路径不产生 SSE parse/tool arg parse 降级） */
  onStreamParseError?: (event: { provider: string; raw: string; error: string }) => void;
  onToolArgParseError?: (event: { provider: string; toolName: string; rawArgs: string; error: string }) => void;

  private readonly config: ProviderConfig;
  private readonly options: PiAiAdapterOptions | undefined;
  private endpointPromise?: Promise<PiAiEndpoint>;

  constructor(config: ProviderConfig, options?: PiAiAdapterOptions) {
    this.config = config;
    this.options = options;
    this.name = config.name;
    this.model = config.model;
  }

  private endpoint(): Promise<PiAiEndpoint> {
    this.endpointPromise ??= createPiAiEndpoint(this.config, {
      ...(this.options?.credentialStore && { credentials: this.options.credentialStore }),
    });
    return this.endpointPromise;
  }

  /** thinking/reasoning 配置 → pi-ai reasoning 档位（undefined = 不启用）。 */
  private reasoningLevel(): ThinkingLevel | undefined {
    if (this.config.reasoningEffort) return this.config.reasoningEffort;
    if (this.config.thinking) return this.config.thinkingEffort ?? 'high';
    return undefined;
  }

  async call(options: LLMCallOptions): Promise<LLMResponse> {
    try {
      return await this.callOnce(options, undefined);
    } catch (err) {
      // output budget 自动调低重试一次（OpenAI 族；沿用旧适配器纪律）
      if (err instanceof LLMOutputBudgetExceededError) {
        const adjusted = err.contextLimit - err.inputTokens;
        if (adjusted > 0) {
          return await this.callOnce(options, adjusted);
        }
      }
      throw err;
    }
  }

  async *stream(options: LLMCallOptions): AsyncIterableIterator<ProviderStreamChunk> {
    let yielded = false;
    try {
      yield* this.streamOnce(options, undefined, () => { yielded = true; });
    } catch (err) {
      // 已产出 chunk 不重试（部分内容已交付，重试会重复）
      if (!yielded && err instanceof LLMOutputBudgetExceededError) {
        const adjusted = err.contextLimit - err.inputTokens;
        if (adjusted > 0) {
          yield* this.streamOnce(options, adjusted, () => { yielded = true; });
          return;
        }
      }
      throw err;
    }
  }

  // ── 内部实现 ─────────────────────────────────────────────────────────────

  private async callOnce(options: LLMCallOptions, maxTokensOverride: number | undefined): Promise<LLMResponse> {
    let finalMessage: PiAi.AssistantMessage | undefined;
    for await (const event of this.runEvents(options, maxTokensOverride)) {
      if (event.type === 'done') {
        finalMessage = event.message;
      }
    }
    if (!finalMessage || finalMessage.content.length === 0) {
      throw new LLMEmptyResponseError(this.name);
    }
    return assistantMessageToLLMResponse(finalMessage);
  }

  private async *streamOnce(
    options: LLMCallOptions,
    maxTokensOverride: number | undefined,
    markYielded: () => void,
  ): AsyncIterableIterator<ProviderStreamChunk> {
    const state = createEventTranslationState();
    for await (const event of this.runEvents(options, maxTokensOverride)) {
      const chunks = translatePiAiEvent(event, state);
      if (!chunks) continue; // error 事件已由 runEvents 抛错
      for (const chunk of chunks) {
        markYielded();
        yield chunk;
      }
    }
  }

  /**
   * 单趟请求：endpoint → context → streamSimple → 事件流（含错误面构造）。
   * error 事件/传输异常在此统一转 typed error 抛出。
   */
  private async *runEvents(
    options: LLMCallOptions,
    maxTokensOverride: number | undefined,
  ): AsyncGenerator<PiAi.AssistantMessageEvent> {
    const { models, model } = await this.endpoint();
    const context = buildPiAiContext(this.config, options, model);
    const timeout = options.timeoutMs ?? this.config.timeoutMs;
    const capture: HttpErrorCapture = {};
    // Google 退化族：pi-ai 适配器拒绝注入 fetch（G1）——不注入，错误面走文本判定
    const googleFamily = isGoogleFamilyApi(model.api);
    const [abortHandle, cleanup] = withCombinedAbortSignal(options.signal, timeout);
    const reasoning = this.reasoningLevel();

    try {
      const stream = models.streamSimple(model, context, {
        signal: abortHandle.signal,
        apiKey: this.config.apiKey,
        ...(googleFamily ? {} : { fetch: createCapturingFetch(capture) }),
        ...(this.config.extraHeaders && { headers: this.config.extraHeaders }),
        maxTokens: maxTokensOverride ?? options.maxTokens ?? this.config.maxTokens,
        temperature: options.temperature ?? this.config.temperature,
        ...(reasoning && { reasoning }),
        ...(reasoning && this.config.thinkingBudgetTokens && {
          thinkingBudgets: { [reasoning]: this.config.thinkingBudgetTokens },
        }),
      });

      for await (const event of stream) {
        if (event.type === 'error') {
          throw await this.constructStreamError(event, capture, options.signal, timeout);
        }
        yield event;
      }
    } catch (err) {
      throw await this.constructThrownError(err, capture, options.signal, timeout);
    } finally {
      cleanup();
    }
  }

  /** error 事件 → typed error。 */
  private async constructStreamError(
    event: Extract<PiAi.AssistantMessageEvent, { type: 'error' }>,
    capture: HttpErrorCapture,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<Error> {
    if (event.reason === 'aborted') {
      if (signal?.aborted) return makeExternalAbortError(signal.reason);
      return this.timeoutOrAbortError(timeoutMs);
    }
    const message = event.error.errorMessage ?? 'unknown provider error';
    const captured = await classifyCapturedHttpError(this.name, this.model, capture);
    if (captured) return captured;
    return classifyTextualError(this.name, this.model, message);
  }

  /** 事件循环抛出的异常 → typed error（abort/网络/已分类透传）。 */
  private async constructThrownError(
    err: unknown,
    capture: HttpErrorCapture,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<Error> {
    if (err instanceof LLMError) return err;
    // ExternalAbortError 非 LLMError 子类：constructStreamError 已分类的外部中止
    // 经事件循环 rethrow 时不得被包成 LLMNetworkError
    if (err instanceof ExternalAbortError) return err;
    const abortClassified = classifyFetchAbortError(err, signal, timeoutMs, this.name);
    if (abortClassified) return abortClassified;
    const captured = await classifyCapturedHttpError(this.name, this.model, capture);
    if (captured) return captured;
    return new LLMNetworkError(
      this.name,
      err instanceof Error ? err : new Error(String(err)),
    );
  }

  private timeoutOrAbortError(timeoutMs: number): Error {
    // aborted 事件但外部 signal 未 abort → 本适配器超时控制器触发
    return new LLMTimeoutError(this.name, timeoutMs);
  }
}

/** pi-ai AssistantMessage → chestnut LLMResponse（call 路径）。 */
function assistantMessageToLLMResponse(message: PiAi.AssistantMessage): LLMResponse {
  const content: LLMResponse['content'] = [];
  for (const block of message.content) {
    if (block.type === 'text') {
      content.push({ type: 'text', text: block.text });
    } else if (block.type === 'thinking') {
      content.push({
        type: 'thinking',
        thinking: block.thinking,
        ...(block.thinkingSignature !== undefined && { signature: block.thinkingSignature }),
      });
    } else if (block.type === 'toolCall') {
      content.push({
        type: 'tool_use',
        id: makeToolUseId(block.id),
        name: block.name,
        input: block.arguments as Record<string, unknown>,
      });
    }
  }
  const usage = mapUsage(message.usage);
  return {
    content,
    stop_reason: mapStopReason(message.stopReason),
    ...(usage && {
      usage: {
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        cache_creation_input_tokens: usage.cacheCreationInputTokens ?? null,
        cache_read_input_tokens: usage.cacheReadInputTokens ?? null,
      },
    }),
    ...(message.responseModel && { model: message.responseModel }),
  };
}
