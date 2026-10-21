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
 * Phase 1941 (D1) 时限分层：call() 的内部 timer 覆盖整次调用的 wall-clock；
 * stream() 的内部 timer 只覆盖发起到首个 provider event，首 event 到达即清除
 * （clearInternalTimeout），后续 chunk 间 idle 由上层（orchestrator
 * streamIdleTimeoutMs）经外部 signal 唯一负责。
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
  LLMContextExceededError,
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
import { createPiAiEndpoint, loadPiAiRuntime, type PiAiEndpoint } from './pi-ai-support.js';
import { resolveContextWindow } from './model-context-windows.js';
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
  inspectSuccessfulMessage,
  isGoogleFamilyApi,
  isPiAiContextOverflowText,
  type HttpErrorCapture,
  type SuccessContextSignal,
} from './pi-ai-errors.js';
import { LLM_PROVIDER_AUDIT_EVENTS } from './audit-events.js';

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
    for await (const event of this.runEvents('call', options, maxTokensOverride)) {
      if (event.type === 'done') {
        finalMessage = event.message;
      }
    }
    if (!finalMessage) {
      throw new LLMEmptyResponseError(this.name);
    }
    // length-stop 先于空响应检查：output=0 的 provider 截断必须进 reactive trim
    const signal = inspectSuccessfulMessage(finalMessage, resolveContextWindow(this.name, this.model));
    if (signal?.kind === 'length_stop_no_output') {
      throw new LLMContextExceededError(
        this.name,
        0,
        'length-stop with zero output (input at/over 99% context window)',
      );
    }
    if (signal) this.observeContextOverflow(signal);
    if (finalMessage.content.length === 0) {
      throw new LLMEmptyResponseError(this.name);
    }
    return assistantMessageToLLMResponse(finalMessage);
  }

  /** silent overflow：只写 audit observation，不改变响应/不触发 trim。 */
  private observeContextOverflow(signal: SuccessContextSignal): void {
    if (signal.kind !== 'silent_overflow') return;
    this.config.auditLog?.write(LLM_PROVIDER_AUDIT_EVENTS.CONTEXT_OVERFLOW_OBSERVED, `provider=${this.name}`, `model=${this.model}`, `kind=silent_overflow`, `input_tokens=${signal.inputTokens}`, `context_window=${signal.contextWindow}`, 'stop_reason=stop');
  }

  private async *streamOnce(
    options: LLMCallOptions,
    maxTokensOverride: number | undefined,
    markYielded: () => void,
  ): AsyncIterableIterator<ProviderStreamChunk> {
    const state = createEventTranslationState();
    for await (const event of this.runEvents('stream', options, maxTokensOverride)) {
      if (event.type === 'done') {
        const signal = inspectSuccessfulMessage(event.message, resolveContextWindow(this.name, this.model));
        if (signal?.kind === 'length_stop_no_output') {
          throw new LLMContextExceededError(
            this.name,
            0,
            'length-stop with zero output (input at/over 99% context window)',
          );
        }
        if (signal) this.observeContextOverflow(signal);
      }
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
   *
   * Phase 1941 (D1)：mode 显式区分调用形态的 timeout 生命周期——
   * - 'call'：内部 timer 覆盖完整事件流（wall-clock 总时长保护）；
   * - 'stream'：内部 timer 只保护首事件前握手阶段，首个内容/终止事件到达即
   *   clearInternalTimeout()，后续生命周期由外部 signal 唯一决定。
   *   注意：pi-ai 的 'start' 事件在拿到响应头时即推送，不代表 provider 已产出
   *   （不得把“请求返回 Response”当作首事件），故首事件判定排除 'start'。
   */
  private async *runEvents(
    mode: 'call' | 'stream',
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

      let firstEventPending = mode === 'stream';
      for await (const event of stream) {
        // Phase 1941 (D1)：stream 首个内容/终止事件到达 → 内部总时长 timer 职责
        // 终止；此后不得再作为流式总时长触发 abort。'start' 仅表示响应头到达，
        // 不算 provider 产出。
        if (firstEventPending && event.type !== 'start') {
          firstEventPending = false;
          abortHandle.clearInternalTimeout();
        }
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
    const contextWindow = resolveContextWindow(this.name, this.model);
    const captured = await classifyCapturedHttpError(
      this.name, this.model, capture, event.error, contextWindow,
    );
    if (captured) return captured;
    // 退化族（Google / 无 status）：共享 pi-ai predicate，替换本地 context 正则
    const runtime = await loadPiAiRuntime();
    return classifyTextualError(
      this.name,
      this.model,
      message,
      (provider, text) => isPiAiContextOverflowText(runtime.isContextOverflow, provider, text),
    );
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
    const captured = await classifyCapturedHttpError(
      this.name, this.model, capture, undefined, resolveContextWindow(this.name, this.model),
    );
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
