/**
 * @module L1.LLMProvider.PiAi.Classify
 *
 * pi-ai 路径 typed error 分类（Phase 1925 Step C 设计稿 D2；Phase 1960 Step B
 * 收敛判定源；Phase 1964 Step C 自 pi-ai-errors.ts 拆出）。
 *
 * status 分类复用 owner 分类器 throwHttpErrorResponse（合成 Response 喂入）；
 * context overflow 判定使用 pi-ai 官方 `isContextOverflow`（动态装载），本地
 * 不复制 provider pattern 列表。retry-after 只取 typed header（phase 1268 禁令）。
 *
 * Google 族（google-generative-ai / google-vertex）= 已登记退化族（设计稿 §7 G1）：
 * HTTP status 与 retry-after 均不可得 → 退回 classifyTextualError 文本判定；
 * LLMRateLimitError 不带 retryAfter、getRetryAfterSec 返回 undefined、退避走
 * 通用策略。此退化与 phase 1268 纪律的冲突已在设计稿显式登记，不得静默放宽。
 */

import type * as PiAi from '@earendil-works/pi-ai';
import {
  LLMError,
  LLMAuthError,
  LLMModelNotFoundError,
  LLMRateLimitError,
  LLMNetworkError,
  LLMContextExceededError,
  LLMOutputBudgetExceededError,
} from './errors.js';
import { LLMInvalidRequestError } from './request-unicode.js';
import { throwHttpErrorResponse, parseOutputBudgetError } from './_helpers.js';
import { loadPiAiRuntime } from './pi-ai-runtime.js';
import { isPiAiContextOverflowText } from './pi-ai-error-text.js';
import type { HttpErrorCapture } from './pi-ai-capture.js';

/**
 * capture 兜底无 HTTP status 时的合成 status。
 *
 * derivation：文本退化族（Google / 无 status）的 context overflow 历史上统一
 * 归 400（旧 `classifyTextualError` 的 `LLMContextExceededError(provider, 400, …)`
 * 分支）；413 必须由真实 status 权威判定，不在无 status 时猜测。
 */
const DEFAULT_CONTEXT_OVERFLOW_STATUS = 400;

/**
 * capture body → provider error message 文本。
 *
 * pi-ai predicate 的 NON_OVERFLOW_PATTERNS（Bedrock throttling 等）以 ^ 锚定
 * message 起始；直接把 JSON envelope 当 errorMessage 会因 `{` 前缀绕过排除。
 * JSON body 抽取 `error.message` / 顶层 `message`，其余（SSE 帧、纯文本）用原文。
 */
function extractProviderErrorText(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === 'object') {
      const errorField = (parsed as { error?: unknown }).error;
      if (errorField && typeof errorField === 'object') {
        const message = (errorField as { message?: unknown }).message;
        if (typeof message === 'string' && message !== '') return message;
      }
      const message = (parsed as { message?: unknown }).message;
      if (typeof message === 'string' && message !== '') return message;
    }
  } catch {
    // silent: 非 JSON body（SSE 帧/纯文本）→ 用原文
  }
  return body;
}

/**
 * normalizeProviderError 的 display form 是 `<status>: <body>`（body 为 JSON 时
 * 带 envelope）。predicate 的 NON_OVERFLOW 锚定在 message 起始，需先去前缀与
 * envelope；非 JSON payload 保持原文（不改变上游 pattern 的适用面）。
 */
function normalizeProviderErrorText(text: string): string {
  const statusPrefix = /^\d{3}:\s*/.exec(text);
  if (!statusPrefix) return text;
  const payload = text.slice(statusPrefix[0].length);
  if (!payload.startsWith('{') && !payload.startsWith('[')) return text;
  return extractProviderErrorText(payload);
}

/**
 * 由截获事实构造 typed error。固定优先级（Phase 1959 §4.2，不得调换）：
 * output budget → HTTP 413 → pi-ai error event predicate → capture 原文兜底 →
 * 既有 status 分类。返回 undefined = 无截获事实。
 */
export async function classifyCapturedHttpError(
  provider: string,
  model: string,
  capture: HttpErrorCapture,
  eventError?: PiAi.AssistantMessage,
  contextWindow?: number,
): Promise<Error | undefined> {
  if (capture.status === undefined && capture.networkError !== undefined) {
    return new LLMNetworkError(
      provider,
      capture.networkError instanceof Error ? capture.networkError : new Error(String(capture.networkError)),
    );
  }
  const runtime = await loadPiAiRuntime();
  const status = capture.status;
  const body = capture.body ?? '';

  // 1) OpenAI 族 output budget 形态（400 特例，先于 context 判定——
  //    budget 文本同时含 "maximum context length"，先跑 context 会吞掉自动调低重试）
  if (status === 400 && body !== '') {
    const budget = parseOutputBudgetError(body);
    if (budget) {
      return new LLMOutputBudgetExceededError(
        provider,
        budget.contextLimit,
        budget.inputTokens,
        budget.requestedMaxTokens,
        body,
      );
    }
  }

  // 2) 413 的 status 是权威事实，先于 event 文本判定
  if (status === 413) {
    return new LLMContextExceededError(provider, 413, body || 'Request Entity Too Large');
  }

  // 3) pi-ai 官方 predicate（error event 完整消息；display form 先归一化）
  if (eventError) {
    const rawText = eventError.errorMessage;
    const probe = rawText === undefined
      ? eventError
      : { ...eventError, errorMessage: normalizeProviderErrorText(rawText) };
    if (runtime.isContextOverflow(probe, contextWindow)) {
      return new LLMContextExceededError(provider, status ?? 0, rawText ?? 'context overflow');
    }
  }

  // 4) capture 原文兜底：只对 400 / 无 status；429/401/403/404/5xx 不进此步。
  //    顶层 message JSON（DashScope 等）经 pi-ai 归一化后只剩 "400 status code
  //    (no body)"，只有 capture.body 能恢复原文。
  if (status === 400 || status === undefined) {
    const text = extractProviderErrorText(body);
    if (text !== '' && isPiAiContextOverflowText(runtime.isContextOverflow, provider, text)) {
      return new LLMContextExceededError(provider, status ?? DEFAULT_CONTEXT_OVERFLOW_STATUS, body);
    }
  }

  if (status === undefined) return undefined;

  const synthetic = new Response(null, {
    status,
    headers: capture.retryAfter ? { 'retry-after': capture.retryAfter } : {},
  });
  try {
    await throwHttpErrorResponse(provider, model, synthetic, body);
  } catch (err) {
    // silent: throw→return 形态转换（typed error 作为返回值上抛给调用方，非吞错）
    return err as Error;
  }
  // throwHttpErrorResponse 对 2xx 不抛——capture 只记非 2xx，防御兜底
  return new LLMError(`Provider ${provider} error (${status}): ${body}`, { provider, status });
}

// ── 退化族文本判定（Google 族；HTTP 事实不可得时的唯一通路，已登记） ──────────

// Phase 1926 Step D：pi-ai ModelsError auth/oauth 面（无 HTTP status 可得）——
// ambient 缺失（AWS 链/ADC/env 未配置 → "Provider is not configured"）、OAuth
// refresh 失败（invalid_grant / token 轮换失败）一律归 auth 类，不得吞成 unknown。
const TEXT_AUTH_RE = /401|403|unauthorized|unauthenticated|permission[_ ]denied|invalid (api )?key|api key not valid|not configured|invalid_grant|refresh token|(token|oauth).{0,20}(refresh|expired|revoked|rejected)/i;
const TEXT_NOT_FOUND_RE = /404|not[_ ]found|does not exist/i;
const TEXT_RATE_LIMIT_RE = /429|rate.?limit|resource_exhausted|too many requests|quota/i;
const TEXT_NETWORK_RE = /econnrefused|enotfound|etimedout|econnreset|fetch failed|network|socket hang up|dns/i;
const TEXT_INVALID_JSON_RE = /failed to parse the request body as json|invalid json request body/i;

/**
 * 退化族错误文本判定（无 HTTP status/header 可用时的 fallback）。
 * 精度上限显式低于注入 fetch 通路：status 为约数（401/404/400），
 * LLMRateLimitError 恒不带 retryAfter（设计稿 G1 登记的退化）。
 */
export function classifyTextualError(
  provider: string,
  model: string,
  message: string,
  isOverflowText: (provider: string, text: string) => boolean,
): Error {
  if (TEXT_RATE_LIMIT_RE.test(message)) {
    return new LLMRateLimitError(provider, undefined);
  }
  if (TEXT_AUTH_RE.test(message)) {
    return new LLMAuthError(provider, 401, message);
  }
  if (TEXT_NOT_FOUND_RE.test(message)) {
    return new LLMModelNotFoundError(provider, model, message);
  }
  if (isOverflowText(provider, normalizeProviderErrorText(message))) {
    return new LLMContextExceededError(provider, 400, message);
  }
  if (TEXT_INVALID_JSON_RE.test(message)) {
    return new LLMInvalidRequestError(provider, 'provider_json_parse_rejected');
  }
  if (TEXT_NETWORK_RE.test(message)) {
    return new LLMNetworkError(provider, new Error(message));
  }
  return new LLMError(`Provider ${provider} error: ${message}`, { provider });
}
