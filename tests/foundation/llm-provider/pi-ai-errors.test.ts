/**
 * Phase 1960 Step B：L1 context overflow 判定矩阵。
 *
 * - isPiAiContextOverflowText：capture 原文 shim 走 pi-ai 官方 predicate；
 * - classifyCapturedHttpError：budget → 413 → event predicate → capture 兜底 → status 分类；
 * - classifyTextualError：退化族文本判定注入共享 predicate，本地不复制 pattern。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import {
  classifyCapturedHttpError,
  classifyTextualError,
  inspectSuccessfulMessage,
  isPiAiContextOverflowText,
  type HttpErrorCapture,
} from '../../../src/foundation/llm-provider/pi-ai-errors.js';
import { loadPiAiRuntime, type PiAiRuntime } from '../../../src/foundation/llm-provider/pi-ai-support.js';
import {
  LLMAuthError,
  LLMContextExceededError,
  LLMError,
  LLMNetworkError,
  LLMOutputBudgetExceededError,
  LLMRateLimitError,
} from '../../../src/foundation/llm-provider/errors.js';
import { LLMInvalidRequestError } from '../../../src/foundation/llm-provider/request-unicode.js';

let runtime: PiAiRuntime;

beforeAll(async () => {
  runtime = await loadPiAiRuntime();
});

function overflowText(provider: string, text: string): boolean {
  return isPiAiContextOverflowText(runtime.isContextOverflow, provider, text);
}

function assistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: 'openai-completions',
    provider: 'aliyun',
    model: 'test-model',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'error',
    timestamp: 0,
    ...overrides,
  } as AssistantMessage;
}

describe('isPiAiContextOverflowText（pi-ai 官方 predicate shim）', () => {
  it.each([
    'Range of input length should be [1, 1000000]',
    "This model's maximum context length is 8192 tokens",
    'prompt is too long: 250000 tokens > 200000 maximum',
    'The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)',
    'Your request exceeded model token limit: 200000 (requested: 250000)',
  ])('matches provider overflow text: %s', (text) => {
    expect(overflowText('aliyun', text)).toBe(true);
  });

  it.each([
    'Throttling error: Too many tokens, please wait before trying again.',
    'rate limit reached: too many requests',
    'You exceeded your current quota, please check your plan',
    'invalid_request: missing field model',
  ])('does not match non-overflow text: %s', (text) => {
    expect(overflowText('bedrock', text)).toBe(false);
  });

  it('handles Cerebras bodyless overflow form', () => {
    expect(overflowText('cerebras', '400 status code (no body)')).toBe(true);
  });
});

describe('inspectSuccessfulMessage（成功响应信号）', () => {
  function successMessage(
    stopReason: AssistantMessage['stopReason'],
    usage: { input: number; output: number; cacheRead?: number },
  ): AssistantMessage {
    return assistantMessage({
      stopReason,
      usage: {
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead ?? 0,
        cacheWrite: 0,
        totalTokens: usage.input + usage.output + (usage.cacheRead ?? 0),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
  }

  function inspect(message: AssistantMessage, contextWindow: number) {
    return inspectSuccessfulMessage(runtime.isContextOverflow, message, contextWindow);
  }

  it('stop + 输入（含 cacheRead）> window → silent_overflow', () => {
    const signal = inspect(successMessage('stop', { input: 200_000, cacheRead: 60_000 }), 256_000);
    expect(signal).toEqual({ kind: 'silent_overflow', inputTokens: 260_000, contextWindow: 256_000 });
  });

  it('stop + 输入 == window → null（严格大于）', () => {
    expect(inspect(successMessage('stop', { input: 256_000 }), 256_000)).toBeNull();
  });

  it('length + output=0 + 输入≥99% → length_stop_no_output', () => {
    const signal = inspect(successMessage('length', { input: 253_440, output: 0 }), 256_000);
    expect(signal).toEqual({ kind: 'length_stop_no_output', inputTokens: 253_440, contextWindow: 256_000 });
  });

  it('length + output=0 + 输入<99% → null', () => {
    expect(inspect(successMessage('length', { input: 253_439, output: 0 }), 256_000)).toBeNull();
  });

  it('length + output>0 → null（bounded retry 另议）', () => {
    expect(inspect(successMessage('length', { input: 260_000, output: 5 }), 256_000)).toBeNull();
  });

  it('thinking/toolUse stop → null', () => {
    expect(inspect(successMessage('toolUse', { input: 300_000, output: 10 }), 256_000)).toBeNull();
  });

  it('error stop + usage>window → null（success 路径不判 provider error）', () => {
    expect(inspect(successMessage('error', { input: 300_000, output: 0 }), 256_000)).toBeNull();
  });
});

describe('classifyCapturedHttpError 固定优先级', () => {
  it('output budget 400 先于 context（返回 LLMOutputBudgetExceededError）', async () => {
    const capture: HttpErrorCapture = {
      status: 400,
      body: 'maximum context length is 8192 tokens. requested 9000 tokens (8000 in the messages, 1000 in the completion)',
    };
    const err = await classifyCapturedHttpError('openai', 'gpt-4o', capture);
    expect(err).toBeInstanceOf(LLMOutputBudgetExceededError);
    expect(err).not.toBeInstanceOf(LLMContextExceededError);
  });

  it('aliyun SSE 原始 body（400）经 capture 兜底判 context', async () => {
    const capture: HttpErrorCapture = {
      status: 400,
      body: 'event:error\ndata: {"error":{"message":"Range of input length should be [1, 1000000]","type":"invalid_parameter_error"}}',
    };
    const err = await classifyCapturedHttpError('aliyun-ds', 'deepseek-v4-pro', capture);
    expect(err).toBeInstanceOf(LLMContextExceededError);
    expect((err as LLMContextExceededError).status).toBe(400);
  });

  it('顶层 message JSON（无 error 包裹）经 capture 兜底判 context', async () => {
    const capture: HttpErrorCapture = {
      status: 400,
      body: '{"message":"Range of input length should be [1, 1000000]"}',
    };
    const err = await classifyCapturedHttpError('aliyun-ds', 'deepseek-v4-pro', capture);
    expect(err).toBeInstanceOf(LLMContextExceededError);
  });

  it('HTTP 413 保留 status，即使 body 为空', async () => {
    const err = await classifyCapturedHttpError('anthropic', 'claude-3', { status: 413 });
    expect(err).toBeInstanceOf(LLMContextExceededError);
    expect((err as LLMContextExceededError).status).toBe(413);
    expect((err as LLMContextExceededError).providerMessage).toBe('Request Entity Too Large');
  });

  it('HTTP 413 先于 event predicate（status 权威）', async () => {
    const eventError = assistantMessage({ errorMessage: 'prompt is too long' });
    const err = await classifyCapturedHttpError(
      'anthropic', 'claude-3', { status: 413, body: 'prompt is too long' }, eventError, 200_000,
    );
    expect(err).toBeInstanceOf(LLMContextExceededError);
    expect((err as LLMContextExceededError).status).toBe(413);
  });

  it('event.error 命中 pi-ai predicate（无 capture status）', async () => {
    const eventError = assistantMessage({ errorMessage: 'Range of input length should be [1, 1000000]' });
    const err = await classifyCapturedHttpError('aliyun-ds', 'deepseek-v4-pro', {}, eventError);
    expect(err).toBeInstanceOf(LLMContextExceededError);
    expect((err as LLMContextExceededError).status).toBe(0);
  });

  it('Bedrock Throttling 文案不被 event predicate 判 context', async () => {
    const eventError = assistantMessage({
      provider: 'amazon-bedrock',
      errorMessage: 'Throttling error: Too many tokens, please wait before trying again.',
    });
    const err = await classifyCapturedHttpError('bedrock', 'claude-3', {}, eventError);
    expect(err).toBeUndefined();
  });

  it('SDK display form `400: {json}` 归一化后仍排除 throttling', async () => {
    const eventError = assistantMessage({
      provider: 'test-provider',
      errorMessage: '400: {"message":"Throttling error: Too many tokens, please wait before trying again."}',
    });
    const err = await classifyCapturedHttpError('test-provider', 'test-model', {}, eventError);
    expect(err).toBeUndefined();
  });

  it('SDK display form `400: {json}` 归一化后仍识别 context', async () => {
    const eventError = assistantMessage({
      provider: 'aliyun',
      errorMessage: '400: {"message":"Range of input length should be [1, 1000000]"}',
    });
    const err = await classifyCapturedHttpError('aliyun-ds', 'deepseek-v4-pro', {}, eventError);
    expect(err).toBeInstanceOf(LLMContextExceededError);
  });

  it('429 不进入 capture 兜底（rate limit 优先）', async () => {
    const capture: HttpErrorCapture = {
      status: 429,
      body: '{"error":{"message":"rate limit reached: too many requests"}}',
      retryAfter: '7',
    };
    const err = await classifyCapturedHttpError('openai', 'gpt-4o', capture);
    expect(err).toBeInstanceOf(LLMRateLimitError);
    expect((err as LLMRateLimitError).retryAfter).toBe(7);
    expect(err).not.toBeInstanceOf(LLMContextExceededError);
  });

  it('401 不进入 capture 兜底', async () => {
    const capture: HttpErrorCapture = {
      status: 401,
      body: '{"error":{"message":"prompt is too long but also unauthorized"}}',
    };
    const err = await classifyCapturedHttpError('openai', 'gpt-4o', capture);
    expect(err).toBeInstanceOf(LLMAuthError);
    expect(err).not.toBeInstanceOf(LLMContextExceededError);
  });

  it('500 不进入 capture 兜底', async () => {
    const capture: HttpErrorCapture = {
      status: 500,
      body: '{"error":{"message":"prompt is too long"}}',
    };
    const err = await classifyCapturedHttpError('openai', 'gpt-4o', capture);
    expect((err as Error).message).toContain('server error (500)');
    expect(err).not.toBeInstanceOf(LLMContextExceededError);
  });

  it('Bedrock JSON envelope 的 throttling 文案不被误判（NON_OVERFLOW 锚定生效）', async () => {
    const capture: HttpErrorCapture = {
      status: 400,
      body: '{"error":{"message":"Throttling error: Too many tokens, please wait before trying again."}}',
    };
    const err = await classifyCapturedHttpError('bedrock', 'claude-3', capture);
    expect(err).toBeInstanceOf(LLMError);
    expect(err).not.toBeInstanceOf(LLMContextExceededError);
  });

  it('普通 400 不误判 context', async () => {
    const capture: HttpErrorCapture = {
      status: 400,
      body: '{"error":{"message":"invalid_request: missing field model"}}',
    };
    const err = await classifyCapturedHttpError('openai', 'gpt-4o', capture);
    expect(err).toBeInstanceOf(LLMError);
    expect(err).not.toBeInstanceOf(LLMContextExceededError);
  });

  it('网络错误优先于一切分类', async () => {
    const err = await classifyCapturedHttpError('openai', 'gpt-4o', {
      networkError: new Error('ECONNRESET'),
    });
    expect(err).toBeInstanceOf(LLMNetworkError);
  });
});

describe('classifyTextualError 注入共享 predicate', () => {
  it('Google 族 context 文案 → LLMContextExceededError', () => {
    const err = classifyTextualError(
      'google', 'gemini-2.5-pro',
      'The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)',
      overflowText,
    );
    expect(err).toBeInstanceOf(LLMContextExceededError);
  });

  it('aliyun Range 文案 → LLMContextExceededError', () => {
    const err = classifyTextualError(
      'aliyun-ds', 'deepseek-v4-pro',
      'Range of input length should be [1, 1000000]',
      overflowText,
    );
    expect(err).toBeInstanceOf(LLMContextExceededError);
  });

  it('Bedrock throttling 文案 → 非 context', () => {
    const err = classifyTextualError(
      'bedrock', 'claude-3',
      'Throttling error: Too many tokens, please wait before trying again.',
      overflowText,
    );
    expect(err).not.toBeInstanceOf(LLMContextExceededError);
  });

  it('保留既有 rate/auth/invalid-json/network 分类', () => {
    expect(classifyTextualError('p', 'm', '429 rate limit reached', overflowText))
      .toBeInstanceOf(LLMRateLimitError);
    expect(classifyTextualError('p', 'm', '401 unauthorized', overflowText))
      .toBeInstanceOf(LLMAuthError);
    expect(classifyTextualError('p', 'm', 'failed to parse the request body as json', overflowText))
      .toBeInstanceOf(LLMInvalidRequestError);
    expect(classifyTextualError('p', 'm', 'fetch failed: socket hang up', overflowText))
      .toBeInstanceOf(LLMNetworkError);
  });
});
