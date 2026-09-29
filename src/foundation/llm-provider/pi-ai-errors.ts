/**
 * @module L1.LLMProvider.PiAi
 *
 * pi-ai 路径 typed error 构造（Phase 1925 Step C，设计稿 D2）。
 *
 * 主信号源 = 注入 fetch 截获（status + retry-after + 非 2xx body clone；成功路径
 * 是 SSE 流，绝不 clone——G2 实现约束）。判定复用本模块 owner 分类器
 * throwHttpErrorResponse（合成 Response 喂入，predicate/正则单源不复制）；
 * retry-after 只取 typed header（phase 1268 禁令，不从 message 正则推导）。
 *
 * Google 族（google-generative-ai / google-vertex）= 已登记退化族（设计稿 §7 G1）：
 * pi-ai 适配器拒绝注入 fetch、onResponse 不存在，HTTP status 与 retry-after 均
 * 不可得 → 退回 classifyTextualError 文本判定；LLMRateLimitError 不带 retryAfter、
 * getRetryAfterSec 返回 undefined、退避走通用策略。此退化与 phase 1268 纪律的
 * 冲突已在设计稿显式登记，不得静默放宽。
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

/** 注入 fetch 的截获结果（每请求一份）。 */
export interface HttpErrorCapture {
  status?: number;
  retryAfter?: string | null;
  body?: string;
  networkError?: unknown;
}

/**
 * 构造截获 fetch：非 2xx 时记录 status/retry-after/body（clone 读文本，原
 * Response 原样返回不扰流）；传输层抛错记录 networkError 后原样上抛。
 * Google 族不得使用（pi-ai 适配器拒绝 custom fetch）——caller 按 api 族跳过。
 */
export function createCapturingFetch(capture: HttpErrorCapture): typeof globalThis.fetch {
  return async (input, init) => {
    try {
      const response = await globalThis.fetch(input, init);
      if (!response.ok) {
        capture.status = response.status;
        capture.retryAfter = response.headers.get('retry-after');
        try {
          capture.body = await response.clone().text();
        } catch {
          // silent: body 读取失败不阻断错误分类（status/header 已在手）
        }
      }
      return response;
    } catch (err) {
      capture.networkError = err;
      throw err;
    }
  };
}

/** 该 model 的 api 是否 Google 退化族（注入 fetch 不可用）。 */
export function isGoogleFamilyApi(api: PiAi.Api | string): boolean {
  return String(api).startsWith('google');
}

/**
 * 由截获事实构造 typed error（复用 owner 分类器 throwHttpErrorResponse，
 * 合成 Response 仅作 status/header 载体）。返回 undefined = 无截获事实。
 */
export async function classifyCapturedHttpError(
  provider: string,
  model: string,
  capture: HttpErrorCapture,
): Promise<Error | undefined> {
  if (capture.status === undefined) {
    if (capture.networkError !== undefined) {
      return new LLMNetworkError(
        provider,
        capture.networkError instanceof Error ? capture.networkError : new Error(String(capture.networkError)),
      );
    }
    return undefined;
  }
  const status = capture.status;
  const body = capture.body ?? '';

  // OpenAI 族 output budget 形态（400 特例，先于通用 400 分类）
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
const TEXT_CONTEXT_RE = /maximum context length|context.{0,30}(exceeded|exceed)|prompt is too long|input.{0,30}(too long|exceed)|reduce the length of|context_length_exceeded|token count.{0,30}exceed/i;
const TEXT_NETWORK_RE = /econnrefused|enotfound|etimedout|econnreset|fetch failed|network|socket hang up|dns/i;
const TEXT_INVALID_JSON_RE = /failed to parse the request body as json|invalid json request body/i;

/**
 * 退化族错误文本判定（无 HTTP status/header 可用时的 fallback）。
 * 精度上限显式低于注入 fetch 通路：status 为约数（401/404/400），
 * LLMRateLimitError 恒不带 retryAfter（设计稿 G1 登记的退化）。
 */
export function classifyTextualError(provider: string, model: string, message: string): Error {
  if (TEXT_RATE_LIMIT_RE.test(message)) {
    return new LLMRateLimitError(provider, undefined);
  }
  if (TEXT_AUTH_RE.test(message)) {
    return new LLMAuthError(provider, 401, message);
  }
  if (TEXT_NOT_FOUND_RE.test(message)) {
    return new LLMModelNotFoundError(provider, model, message);
  }
  if (TEXT_CONTEXT_RE.test(message)) {
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
