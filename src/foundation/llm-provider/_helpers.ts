/**
 * HTTP 5xx server error 起点（RFC 7231 §6.6 status code range start）。
 * 用于 LLM provider response 错误分类、>= 此值视为 server-side 错误。
 */
const HTTP_SERVER_ERROR_STATUS_MIN = 500;

import { LLMError, LLMRateLimitError, LLMQuotaError, LLMAuthError, LLMModelNotFoundError, LLMContextExceededError, type InputBudgetEvidence } from './errors.js';
import { LLMInvalidRequestError } from './request-unicode.js';

const REQUEST_BODY_PARSE_RE = /failed to parse the request body as json|invalid json request body/i;
const QUOTA_429_RE = /accountquotaexceeded|allocationquota|quota[\s\S]*reset|reset[\s\S]*quota/i;
const QUOTA_RESET_RE = /\breset(?:\s+(?:at|on))?\s*[:=]?\s*(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})\b/i;

/** 只接受带数字偏移或 Z 的 reset 时间；无法确定的日期不进入 typed 下界。 */
function parseProviderResetTime(body: string): number | undefined {
  const match = body.match(QUOTA_RESET_RE);
  if (!match) return undefined;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = '', offset] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return undefined;
  if (hour > 23 || minute > 59 || second > 59) return undefined;
  const offsetMatch = offset.match(/^[+-](\d{2}):?(\d{2})$/);
  if (offsetMatch && (Number(offsetMatch[1]) > 23 || Number(offsetMatch[2]) > 59)) return undefined;
  const normalizedOffset = offset === 'Z' || offset.includes(':')
    ? offset
    : `${offset.slice(0, 3)}:${offset.slice(3)}`;
  const milliseconds = `${fraction.slice(1)}000`.slice(0, 3);
  const parsed = Date.parse(`${yearText}-${monthText}-${dayText}T${hourText}:${minuteText}:${secondText}.${milliseconds}${normalizedOffset}`);
  if (!Number.isFinite(parsed)) return undefined;
  // 超出毫秒精度的非零尾部向上取整，真实 probe 不得早于 provider reset 下界。
  const subMillisecondRemainder = fraction.length > 4 && /[1-9]/.test(fraction.slice(4));
  return parsed + (subMillisecondRemainder ? 1 : 0);
}

/**
 * Parse HTTP error response and throw the appropriate LLMError subclass.
 *
 * Handles fetch Response with 4xx/5xx status:
 * - 402 → LLMQuotaError with the original provider message
 * - 429 → 明确 quota body 为 LLMQuotaError；其余保持 LLMRateLimitError
 * - 5xx → LLMError "server error" tier
 * - else → LLMError generic
 *
 * Called by classifyCapturedHttpError (pi-ai-classify.ts)：pi-ai 捕获的 HTTP 错误
 * 以合成 Response + captured errorText 喂入本函数分类（phase 1925 后唯一生产调用点）。
 *
 * Message format unified: `Provider ${provider} (server )?error (${status}): ${text}`
 * (gemini's historical "Server error" / "Request failed" format aligned to standard
 * by phase 592 / 28 原则核 5/5 dominant α / M#1+M#7+D5 align).
 */
export async function throwHttpErrorResponse(
  provider: string,
  model: string,
  response: Response,
  errorText?: string,
  inputBudget?: InputBudgetEvidence,
): Promise<never> {
  const status = response.status;
  let resolvedErrorText: string;
  let quotaEvidenceText: string;

  if (errorText !== undefined) {
    resolvedErrorText = errorText;
    quotaEvidenceText = errorText;
  } else {
    const cloned = response.clone();
    try {
      const errorData = await response.json() as { error?: { message?: string } };
      resolvedErrorText = errorData.error?.message ?? JSON.stringify(errorData);
      // 展示文本可能只取 error.message；quota 分类仍须看到 error.code 等原始字段。
      quotaEvidenceText = JSON.stringify(errorData);
    } catch {
      // silent: json parse fallback — use raw text instead
      resolvedErrorText = await cloned.text();
      quotaEvidenceText = resolvedErrorText;
    }
  }

  // phase 735 step 2: 401/403/404 分类（permanent / 0 retry）
  // phase 445: 404 用 caller 传入 model（权威源）+ errorText 作 providerMessage、
  // 不再用 regex 反查 errorText（provider 返自然语言 "The model does not exist" 时反查抓到 "does"）
  if (status === 401 || status === 403) {
    throw new LLMAuthError(provider, status, resolvedErrorText);
  }
  if (status === 404) {
    throw new LLMModelNotFoundError(provider, model, resolvedErrorText);
  }

  if (status === 402) {
    throw new LLMQuotaError(provider, resolvedErrorText);
  }

  if (status === 429) {
    const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
    if (QUOTA_429_RE.test(quotaEvidenceText)) {
      const resetAtMs = parseProviderResetTime(quotaEvidenceText);
      throw new LLMQuotaError(provider, resolvedErrorText, {
        ...(retryAfter !== undefined ? { retryAfter } : {}),
        ...(resetAtMs !== undefined ? { resetAtMs } : {}),
      });
    }
    throw new LLMRateLimitError(provider, retryAfter);
  }

  // Phase 1960: 413 的 status 是权威事实，归 context_exceeded（用户拍板）
  if (status === 413) {
    throw new LLMContextExceededError(provider, status, resolvedErrorText, inputBudget);
  }

  // Phase 1154: deterministic provider-side JSON parse rejection → permanent invalid request
  if (status === 400 && REQUEST_BODY_PARSE_RE.test(resolvedErrorText)) {
    throw new LLMInvalidRequestError(provider, 'provider_json_parse_rejected');
  }

  if (status >= HTTP_SERVER_ERROR_STATUS_MIN) {
    throw new LLMError(
      `Provider ${provider} server error (${status}): ${resolvedErrorText}`,
      { provider, status },
    );
  }

  throw new LLMError(
    `Provider ${provider} error (${status}): ${resolvedErrorText}`,
    { provider, status },
  );
}

interface ParsedOutputBudgetError {
  contextLimit: number;
  inputTokens: number;
  requestedMaxTokens: number;
}

const OUTPUT_BUDGET_EXCEEDED_RE =
  /maximum context length is (\d+) tokens[\s\S]*?requested (\d+) tokens[\s\S]*?(\d+) in the messages[\s\S]*?(\d+) in the completions?/i;

export function parseOutputBudgetError(message: string): ParsedOutputBudgetError | null {
  const m = message.match(OUTPUT_BUDGET_EXCEEDED_RE);
  if (!m) return null;
  return {
    contextLimit: parseInt(m[1], 10),
    inputTokens: parseInt(m[3], 10),
    requestedMaxTokens: parseInt(m[4], 10),
  };
}

/**
 * Parse HTTP `Retry-After` header value to integer.
 *
 * Per HTTP spec the value is in **seconds** (or HTTP-date — only delta-seconds
 * supported here). Returns the raw integer or undefined if the header is
 * absent / empty / non-numeric.
 *
 * **phase 592 normalize NaN to undefined**（revoke phase 563 prior behavior preservation）：
 * - phase 563 jsdoc 原文「does not normalize NaN — preserves prior behavior」
 * - 0 downstream consumer 用 `.retryAfter` field（grep verify）
 * - NaN 是 type liar (number) / D2 silent NaN propagation 是 latent bug
 * - 加 `Number.isNaN(ms) ? undefined : ms` guard 严格化返值 type 契约
 *
 * Used by throwHttpErrorResponse (phase 592)——pi-ai 路径的 retry-after 只取
 * typed header（429 分类时经本函数解析 delta-seconds）。
 */
export function parseRetryAfter(
  headerValue: string | null | undefined,
): number | undefined {
  if (!headerValue) return undefined;
  const ms = parseInt(headerValue, 10);
  return Number.isNaN(ms) ? undefined : ms;
}
