/**
 * Phase 1925 Step C: PiAiAdapter 行为测试。
 *
 * mock 方式：vi.stubGlobal('fetch') 手搓协议真形态 SSE / 错误响应（与旧适配器
 * 测试同形），经 createLLMProvider factory 拿 adapter（pi-ai 动态 import 真实
 * 执行——协议解析走 pi-ai 真实现，不 mock pi-ai 本身）。
 * 覆盖：三协议 text/tool/thinking/usage chunk 语义、typed error 分类
 * （401/404/429+retry-after/400 context/400 budget/500/network/abort/timeout）、
 * catalog 命中与 baseUrl 覆盖、自建 Model、extra headers、apiKey 传递、
 * dropThinkingBlocks、output budget 自动重试、Google 族退化（无注入 fetch）。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createLLMProvider } from '../../../src/foundation/llm-provider/provider-factory.js';
import type { ProviderConfig, ProviderStreamChunk } from '../../../src/foundation/llm-provider/index.js';
import {
  LLMAuthError,
  LLMModelNotFoundError,
  LLMRateLimitError,
  LLMContextExceededError,
  LLMOutputBudgetExceededError,
  LLMTimeoutError,
  LLMNetworkError,
  LLMError,
  LLMEmptyResponseError,
} from '../../../src/foundation/llm-provider/index.js';
import { ExternalAbortError } from '../../../src/foundation/llm-provider/abort-helper.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function baseConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    name: 'test-provider',
    apiKey: 'sk-test-key',
    baseUrl: 'https://api.test.invalid/v1',
    model: 'test-model',
    temperature: 0.7,
    timeoutMs: 60_000,
    apiFormat: 'openai',
    ...overrides,
  };
}

function sseResponse(lines: string[], status = 200, headers: Record<string, string> = {}): Response {
  // SSE 事件之间必须空行分隔（否则 pi-ai 将相邻 data 行视为同一事件的多 data 字段拼接）
  const body = lines.map((l) => `${l}\n\n`).join('');
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/event-stream', ...headers },
  });
}

function jsonResponse(data: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** OpenAI chat.completions SSE 帧 */
function openaiSse(frames: unknown[]): string[] {
  return [...frames.map((f) => `data: ${JSON.stringify(f)}`), 'data: [DONE]'];
}

function openaiTextFrames(text: string, finish = 'stop'): unknown[] {
  return [
    { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] },
    { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } },
  ];
}

async function collectChunks(adapter: { stream?: (o: object) => AsyncIterableIterator<ProviderStreamChunk> }): Promise<ProviderStreamChunk[]> {
  const chunks: ProviderStreamChunk[] = [];
  for await (const chunk of adapter.stream!({ messages: [{ role: 'user', content: 'hi' }] })) {
    chunks.push(chunk);
  }
  return chunks;
}

describe('PiAiAdapter — openai-completions 协议', () => {
  it('text delta + usage + stopReason 归一（end_turn）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(openaiSse(openaiTextFrames('hello')))));
    const adapter = createLLMProvider(baseConfig());
    const chunks = await collectChunks(adapter);
    expect(chunks).toContainEqual({ type: 'text_delta', delta: 'hello' });
    const done = chunks.find((c) => c.type === 'done');
    expect(done).toBeDefined();
    expect(done!.stopReason).toBe('end_turn');
    expect(done!.usage).toMatchObject({ inputTokens: 11, outputTokens: 7 });
  });

  it('call() 返回 LLMResponse（text + usage snake_case）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(openaiSse(openaiTextFrames('world')))));
    const adapter = createLLMProvider(baseConfig());
    const response = await adapter.call({ messages: [{ role: 'user', content: 'hi' }] });
    expect(response.content).toEqual([{ type: 'text', text: 'world' }]);
    expect(response.stop_reason).toBe('end_turn');
    expect(response.usage).toMatchObject({ input_tokens: 11, output_tokens: 7 });
  });

  it('tool call：start 带 id/name、delta 拼接语义、finish toolUse → tool_use', async () => {
    const frames = [
      { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '' } }] }, finish_reason: null }] },
      { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":"Par' } }] }, finish_reason: null }] },
      { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'is"}' } }] }, finish_reason: null }] },
      { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } },
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(openaiSse(frames))));
    const adapter = createLLMProvider(baseConfig());
    const chunks = await collectChunks(adapter);

    const start = chunks.find((c) => c.type === 'tool_use_start');
    expect(start?.toolUse).toMatchObject({ id: 'call_1', name: 'get_weather' });
    const deltas = chunks.filter((c) => c.type === 'tool_use_delta');
    expect(deltas.length).toBeGreaterThan(0);
    const assembled = deltas.map((d) => d.toolUse?.partialInput ?? '').join('');
    expect(JSON.parse(assembled)).toEqual({ city: 'Paris' });
    expect(chunks.find((c) => c.type === 'done')?.stopReason).toBe('tool_use');
  });

  it('call() tool call 交付已解析 input', async () => {
    const frames = [
      { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_9', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }] }, finish_reason: null }] },
      { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(openaiSse(frames))));
    const adapter = createLLMProvider(baseConfig());
    const response = await adapter.call({ messages: [{ role: 'user', content: 'hi' }] });
    expect(response.content).toEqual([
      { type: 'tool_use', id: 'call_9', name: 'f', input: { a: 1 } },
    ]);
    expect(response.stop_reason).toBe('tool_use');
  });

  it('apiKey → Authorization Bearer、baseUrl → /chat/completions、extraHeaders 透传', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(openaiSse(openaiTextFrames('ok'))));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = createLLMProvider(baseConfig({
      baseUrl: 'https://gateway.example.com/v1',
      extraHeaders: { 'X-Custom': 'yes' },
    }));
    await adapter.call({ messages: [{ role: 'user', content: 'hi' }] });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://gateway.example.com/v1/chat/completions');
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe('Bearer sk-test-key');
    expect(headers.get('x-custom')).toBe('yes');
  });

  it('401 → LLMAuthError（status+body 来自注入 fetch 截获）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: { message: 'bad key' } }, 401)));
    const adapter = createLLMProvider(baseConfig());
    await expect(adapter.call({ messages: [{ role: 'user', content: 'hi' }] }))
      .rejects.toBeInstanceOf(LLMAuthError);
  });

  it('404 → LLMModelNotFoundError（model 为权威源）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: { message: 'no such model' } }, 404)));
    const adapter = createLLMProvider(baseConfig());
    await expect(adapter.call({ messages: [{ role: 'user', content: 'hi' }] }))
      .rejects.toBeInstanceOf(LLMModelNotFoundError);
  });

  it('429 + retry-after → LLMRateLimitError 带 typed retryAfter 秒数', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonResponse({ error: { message: 'slow down' } }, 429, { 'retry-after': '7' }),
    ));
    const adapter = createLLMProvider(baseConfig());
    try {
      await adapter.call({ messages: [{ role: 'user', content: 'hi' }] });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(LLMRateLimitError);
      expect((err as InstanceType<typeof LLMRateLimitError>).retryAfter).toBe(7);
    }
  });

  it('400 context 字面 → LLMContextExceededError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonResponse({ error: { message: "This model's maximum context length is 8192 tokens" } }, 400),
    ));
    const adapter = createLLMProvider(baseConfig());
    await expect(adapter.call({ messages: [{ role: 'user', content: 'hi' }] }))
      .rejects.toBeInstanceOf(LLMContextExceededError);
  });

  it('500 → LLMError server 档', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: { message: 'boom' } }, 500)));
    const adapter = createLLMProvider(baseConfig());
    const err = await adapter.call({ messages: [{ role: 'user', content: 'hi' }] }).catch((e) => e);
    expect(err).toBeInstanceOf(LLMError);
    expect((err as Error).message).toContain('server error (500)');
  });

  it('传输层抛错 → LLMNetworkError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')));
    const adapter = createLLMProvider(baseConfig());
    await expect(adapter.call({ messages: [{ role: 'user', content: 'hi' }] }))
      .rejects.toBeInstanceOf(LLMNetworkError);
  });

  it('output budget 400 → 自动调低 maxTokens 重试一次', async () => {
    const budgetMessage = 'maximum context length is 8192 tokens. requested 9000 tokens (8000 in the messages, 1000 in the completion)';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: budgetMessage } }, 400))
      .mockResolvedValueOnce(sseResponse(openaiSse(openaiTextFrames('retried'))));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = createLLMProvider(baseConfig());
    const response = await adapter.call({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 1000 });
    expect(response.content).toEqual([{ type: 'text', text: 'retried' }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    // pi-ai openai-completions 缺省使用 max_completion_tokens 字段（compat.maxTokensField）
    expect(secondBody.max_completion_tokens).toBe(8192 - 8000);
  });

  it('空 done（零内容块）→ LLMEmptyResponseError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(openaiSse([
      { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ]))));
    const adapter = createLLMProvider(baseConfig());
    await expect(adapter.call({ messages: [{ role: 'user', content: 'hi' }] }))
      .rejects.toBeInstanceOf(LLMEmptyResponseError);
  });

  it('外部 signal abort → ExternalAbortError（非 typed timeout）', async () => {
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_u: string, init: RequestInit) => {
      controller.abort();
      // 模拟传输尊重 signal
      throw new DOMException('The operation was aborted', 'AbortError');
    }));
    const adapter = createLLMProvider(baseConfig());
    const err = await adapter.call({
      messages: [{ role: 'user', content: 'hi' }],
      signal: controller.signal,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ExternalAbortError);
  });

  it('内部超时 → LLMTimeoutError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_u: string, init: RequestInit) => {
      await new Promise((resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }));
    const adapter = createLLMProvider(baseConfig({ timeoutMs: 50 }));
    await expect(adapter.call({ messages: [{ role: 'user', content: 'hi' }] }))
      .rejects.toBeInstanceOf(LLMTimeoutError);
  });
});

/**
 * Phase 1960 Step B：context overflow 检测矩阵（L1 单一入口）。
 * pi-ai 官方 predicate 为 event 主判定，capture 原文兜底顶层 message/SSE；
 * 429/401/5xx 与普通 400 不得被拖入 context。
 */
describe('PiAiAdapter — Phase 1960 context overflow 检测', () => {
  it('aliyun SSE event:error（HTTP 400）→ LLMContextExceededError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      'event:error\ndata: {"error":{"message":"Range of input length should be [1, 1000000]","type":"invalid_parameter_error"}}\n\n',
      { status: 400, headers: { 'content-type': 'text/event-stream' } },
    )));
    const adapter = createLLMProvider(baseConfig({
      name: 'aliyun-ds',
      model: 'deepseek-v4-pro',
    }));
    const err = await adapter.call({ messages: [{ role: 'user', content: 'hi' }] }).catch((e) => e);
    expect(err).toBeInstanceOf(LLMContextExceededError);
    expect((err as InstanceType<typeof LLMContextExceededError>).status).toBe(400);
  });

  it('aliyun 顶层 message JSON（HTTP 400）→ LLMContextExceededError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(
      { message: 'Range of input length should be [1, 1000000]' },
      400,
    )));
    const adapter = createLLMProvider(baseConfig({
      name: 'aliyun-ds',
      model: 'deepseek-v4-pro',
    }));
    await expect(adapter.call({ messages: [{ role: 'user', content: 'hi' }] }))
      .rejects.toBeInstanceOf(LLMContextExceededError);
  });

  it('HTTP 413 → LLMContextExceededError(status=413)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(
      { error: { message: 'request too large' } },
      413,
    )));
    const adapter = createLLMProvider(baseConfig());
    const err = await adapter.call({ messages: [{ role: 'user', content: 'hi' }] }).catch((e) => e);
    expect(err).toBeInstanceOf(LLMContextExceededError);
    expect((err as InstanceType<typeof LLMContextExceededError>).status).toBe(413);
  });

  it('429 + rate-limit 文案不被拖入 context', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(
      { error: { message: 'rate limit reached: too many requests' } },
      429,
      { 'retry-after': '3' },
    )));
    const adapter = createLLMProvider(baseConfig());
    const err = await adapter.call({ messages: [{ role: 'user', content: 'hi' }] }).catch((e) => e);
    expect(err).toBeInstanceOf(LLMRateLimitError);
    expect(err).not.toBeInstanceOf(LLMContextExceededError);
  });

  it('Bedrock throttling "Too many tokens" → 非 context', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(
      { error: { message: 'Throttling error: Too many tokens, please wait before trying again.' } },
      400,
    )));
    const adapter = createLLMProvider(baseConfig());
    const err = await adapter.call({ messages: [{ role: 'user', content: 'hi' }] }).catch((e) => e);
    expect(err).toBeInstanceOf(LLMError);
    expect(err).not.toBeInstanceOf(LLMContextExceededError);
  });

  it('普通 400 invalid_request → 非 context', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(
      { error: { message: 'invalid_request: missing field model' } },
      400,
    )));
    const adapter = createLLMProvider(baseConfig());
    const err = await adapter.call({ messages: [{ role: 'user', content: 'hi' }] }).catch((e) => e);
    expect(err).toBeInstanceOf(LLMError);
    expect(err).not.toBeInstanceOf(LLMContextExceededError);
  });

  it('output budget 400 仍走 LLMOutputBudgetExceededError（priority 不回归）', async () => {
    const budgetMessage = 'maximum context length is 8192 tokens. requested 9000 tokens (8000 in the messages, 1000 in the completion)';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: budgetMessage } }, 400))
      .mockResolvedValueOnce(jsonResponse({ error: { message: budgetMessage } }, 400));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = createLLMProvider(baseConfig());
    const err = await adapter.call({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 1000 }).catch((e) => e);
    expect(err).toBeInstanceOf(LLMOutputBudgetExceededError);
    expect(err).not.toBeInstanceOf(LLMContextExceededError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

/**
 * Phase 1960 Step C：成功响应 context 观测。
 * - silent overflow 只写 audit，不 throw / 不 trim / 不改响应；
 * - length-stop（output=0 + 输入≥99%）判 context_exceeded，进 reactive trim。
 * context window：test-provider/test-model 未命中 1M 特判 → 256000。
 */
describe('PiAiAdapter — Phase 1960 成功响应 context 观测', () => {
  const CONTEXT_WINDOW = 256_000;

  function auditSink() {
    return { write: vi.fn(), preview: (s: string) => s };
  }

  function openaiFramesWithUsage(
    text: string | null,
    finish: string,
    usage: { prompt: number; completion: number },
  ): unknown[] {
    const frames: unknown[] = [];
    const delta = text === null
      ? { choices: [{ index: 0, delta: {}, finish_reason: null }] }
      : { choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] };
    frames.push({ id: 'c1', object: 'chat.completion.chunk', ...delta });
    frames.push({
      id: 'c1',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: finish }],
      usage: {
        prompt_tokens: usage.prompt,
        completion_tokens: usage.completion,
        total_tokens: usage.prompt + usage.completion,
      },
    });
    return frames;
  }

  it('call silent overflow：只写 audit，响应正常返回', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(openaiSse(
      openaiFramesWithUsage('hello', 'stop', { prompt: CONTEXT_WINDOW + 44_000, completion: 7 }),
    ))));
    const auditLog = auditSink();
    const adapter = createLLMProvider(baseConfig({ auditLog }));
    const response = await adapter.call({ messages: [{ role: 'user', content: 'hi' }] });

    expect(response.content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(response.stop_reason).toBe('end_turn');
    expect(auditLog.write).toHaveBeenCalledTimes(1);
    const [event, ...details] = auditLog.write.mock.calls[0];
    expect(event).toBe('llm_context_overflow_observed');
    expect(details).toEqual(expect.arrayContaining([
      'provider=test-provider',
      'model=test-model',
      'kind=silent_overflow',
      `input_tokens=${CONTEXT_WINDOW + 44_000}`,
      `context_window=${CONTEXT_WINDOW}`,
      'stop_reason=stop',
    ]));
  });

  it('stream silent overflow：写 audit 且正常交付 done', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(openaiSse(
      openaiFramesWithUsage('hello', 'stop', { prompt: CONTEXT_WINDOW + 1, completion: 2 }),
    ))));
    const auditLog = auditSink();
    const adapter = createLLMProvider(baseConfig({ auditLog }));
    const chunks = await collectChunks(adapter);

    expect(chunks).toContainEqual({ type: 'text_delta', delta: 'hello' });
    expect(chunks.some((c) => c.type === 'done')).toBe(true);
    expect(auditLog.write).toHaveBeenCalledTimes(1);
    expect(auditLog.write.mock.calls[0][0]).toBe('llm_context_overflow_observed');
  });

  it('silent 边界：输入 == window 不写 audit', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(openaiSse(
      openaiFramesWithUsage('hello', 'stop', { prompt: CONTEXT_WINDOW, completion: 2 }),
    ))));
    const auditLog = auditSink();
    const adapter = createLLMProvider(baseConfig({ auditLog }));
    await adapter.call({ messages: [{ role: 'user', content: 'hi' }] });
    expect(auditLog.write).not.toHaveBeenCalled();
  });

  it('call length-stop（output=0 + 输入≥99%）→ LLMContextExceededError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(openaiSse(
      openaiFramesWithUsage(null, 'length', { prompt: Math.ceil(CONTEXT_WINDOW * 0.99), completion: 0 }),
    ))));
    const auditLog = auditSink();
    const adapter = createLLMProvider(baseConfig({ auditLog }));
    const err = await adapter.call({ messages: [{ role: 'user', content: 'hi' }] }).catch((e) => e);

    expect(err).toBeInstanceOf(LLMContextExceededError);
    expect((err as InstanceType<typeof LLMContextExceededError>).status).toBe(0);
    expect(auditLog.write).not.toHaveBeenCalled();
  });

  it('stream length-stop（output=0 + 输入≥99%）→ LLMContextExceededError（done 未交付）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(openaiSse(
      openaiFramesWithUsage(null, 'length', { prompt: Math.ceil(CONTEXT_WINDOW * 0.99), completion: 0 }),
    ))));
    const adapter = createLLMProvider(baseConfig());
    const err = await collectChunks(adapter).catch((e) => e);

    expect(err).toBeInstanceOf(LLMContextExceededError);
  });

  it('length + output>0 → 不判 context（max_tokens 正常返回）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(openaiSse(
      openaiFramesWithUsage('partial', 'length', { prompt: CONTEXT_WINDOW + 10_000, completion: 5 }),
    ))));
    const auditLog = auditSink();
    const adapter = createLLMProvider(baseConfig({ auditLog }));
    const response = await adapter.call({ messages: [{ role: 'user', content: 'hi' }] });

    expect(response.stop_reason).toBe('max_tokens');
    expect(auditLog.write).not.toHaveBeenCalled();
  });

  it('length + output=0 + 输入<99% → 不判 context（落 empty response）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(openaiSse(
      openaiFramesWithUsage(null, 'length', { prompt: 200_000, completion: 0 }),
    ))));
    const adapter = createLLMProvider(baseConfig());
    const err = await adapter.call({ messages: [{ role: 'user', content: 'hi' }] }).catch((e) => e);

    expect(err).toBeInstanceOf(LLMEmptyResponseError);
    expect(err).not.toBeInstanceOf(LLMContextExceededError);
  });
});

/**
 * Phase 1941 (D1) 时限分层回归：
 * - stream 的 timeoutMs 只覆盖首事件前握手；首 event 后持续 chunk 总时长超过
 *   timeoutMs 不得被 adapter 内部 timer 中止（本 phase 修复的缺陷形态）；
 * - call 的 timeoutMs 仍是整次调用的 wall-clock 上限；
 * - 用户 abort 在首事件前后均归因为 ExternalAbortError，不误报 provider timeout。
 *
 * mock 方式同上：真实 pi-ai 协议解析 + 手搓可控滴流 SSE body（真实计时器，
 * 不用 fake timer 证明整条异步链）。
 */
describe('PiAiAdapter — Phase 1941 时限分层（stream 首事件时限 vs call 总时长）', () => {
  /** 可控滴流 SSE Response：按 delays 逐帧 enqueue；signal abort 时以 AbortError 终止 body（对齐真实 fetch 行为）。 */
  function dripSseResponse(lines: string[], delays: number[], signal?: AbortSignal): Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let i = 0;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const onAbort = () => {
          if (timer) clearTimeout(timer);
          controller.error(new DOMException('The operation was aborted', 'AbortError'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        const push = () => {
          if (i >= lines.length) {
            signal?.removeEventListener('abort', onAbort);
            controller.close();
            return;
          }
          const idx = i++;
          timer = setTimeout(() => {
            controller.enqueue(encoder.encode(`${lines[idx]}\n\n`));
            push();
          }, delays[idx] ?? 0);
        };
        push();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }

  /** 三段文本滴流帧（delta a / delta b / finish stop + usage）。 */
  function dripFrames(): unknown[] {
    return [
      { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'a' }, finish_reason: null }] },
      { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'b' }, finish_reason: null }] },
      { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
    ];
  }

  async function collectStream(
    adapter: { stream: (o: object) => AsyncIterableIterator<ProviderStreamChunk> },
    options: Record<string, unknown> = {},
  ): Promise<ProviderStreamChunk[]> {
    const chunks: ProviderStreamChunk[] = [];
    for await (const chunk of adapter.stream({ messages: [{ role: 'user', content: 'hi' }], ...options })) {
      chunks.push(chunk);
    }
    return chunks;
  }

  it('stream 首事件迟于 timeoutMs → LLMTimeoutError（provider/timeoutMs 可审计）', async () => {
    // 首帧 400ms 才到；timeoutMs=100 的内部 timer 先触发
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_u: string, init: RequestInit) =>
      dripSseResponse(openaiSse(dripFrames()), [400, 10, 10, 5], init.signal ?? undefined)));
    const adapter = createLLMProvider(baseConfig({ timeoutMs: 100 }));
    const err = await collectStream(adapter).catch((e) => e);
    expect(err).toBeInstanceOf(LLMTimeoutError);
    expect((err as LLMTimeoutError).context).toMatchObject({ provider: 'test-provider', timeoutMs: 100 });
  });

  it('stream 首事件及时到达、持续 chunk 总时长超过 timeoutMs → 成功完成（缺陷回归）', async () => {
    // 首帧 20ms（< 150ms 握手上限）；随后每 250ms 一帧，总时长 ~525ms > timeoutMs=150。
    // 旧行为：150ms 内部总时长 timer 误杀；修复后首 event 即清除该 timer。
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_u: string, init: RequestInit) =>
      dripSseResponse(openaiSse(dripFrames()), [20, 250, 250, 5], init.signal ?? undefined)));
    const adapter = createLLMProvider(baseConfig({ timeoutMs: 150 }));
    const chunks = await collectStream(adapter);
    const deltas = chunks.filter((c) => c.type === 'text_delta').map((c) => (c as { delta: string }).delta);
    expect(deltas).toEqual(['a', 'b']);
    expect(chunks.some((c) => c.type === 'done')).toBe(true);
  });

  it('stream 首事件后消费方提前关闭 → cleanup 执行，无残留 abort/泄漏', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_u: string, init: RequestInit) =>
      dripSseResponse(openaiSse(dripFrames()), [20, 150, 150, 5], init.signal ?? undefined)));
    const adapter = createLLMProvider(baseConfig({ timeoutMs: 100 }));
    const iter = adapter.stream({ messages: [{ role: 'user', content: 'hi' }] });
    const first = await iter.next();
    expect(first.done).toBe(false);
    // 消费方提前 return（等价 break for-await）→ generator finally 必须跑 cleanup
    await iter.return(undefined);
    // Derivation: 200ms > 本用例 timeoutMs=100ms，确保跨过“若 timer 未清理则必触发”
    // 的窗口，以观察提前 return 后无残留 abort/未捕获拒绝。
    const POST_RETURN_OBSERVE_MS = 200;
    await new Promise((resolve) => setTimeout(resolve, POST_RETURN_OBSERVE_MS));
  });

  it('stream 首事件后用户 abort（晚于 timeoutMs）→ ExternalAbortError 而非 LLMTimeoutError', async () => {
    // 首帧 20ms 清除内部 timer(timeoutMs=100)；外部 abort 在 150ms 才到。
    // 若内部 timer 未清除，100ms 会先触发并被误报为 LLMTimeoutError。
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_u: string, init: RequestInit) =>
      dripSseResponse(openaiSse(dripFrames()), [20, 5000, 10, 5], init.signal ?? undefined)));
    const adapter = createLLMProvider(baseConfig({ timeoutMs: 100 }));
    const pending = collectStream(adapter, { signal: controller.signal });
    // Derivation: 150ms > timeoutMs=100ms——若内部 timer 未在首帧（20ms）清除，
    // 100ms 会先触发为 LLMTimeoutError；150ms 的外部 abort 才能鉴别归因。
    const USER_ABORT_AFTER_FIRST_EVENT_MS = 150;
    setTimeout(() => controller.abort({ type: 'user' }), USER_ABORT_AFTER_FIRST_EVENT_MS);
    const err = await pending.catch((e) => e);
    expect(err).toBeInstanceOf(ExternalAbortError);
    expect((err as ExternalAbortError).cause).toEqual({ type: 'user' });
  });

  it('stream 首事件前用户 abort → ExternalAbortError（非 timeout）', async () => {
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_u: string, init: RequestInit) =>
      dripSseResponse(openaiSse(dripFrames()), [500, 10, 10, 5], init.signal ?? undefined)));
    const adapter = createLLMProvider(baseConfig({ timeoutMs: 5000 }));
    const pending = collectStream(adapter, { signal: controller.signal });
    // Derivation: 30ms < 首帧 500ms 且 << timeoutMs=5000ms——abort 必然落在
    // 首事件前窗口，且不会被内部 timer 抢跑。
    const USER_ABORT_BEFORE_FIRST_EVENT_MS = 30;
    setTimeout(() => controller.abort({ type: 'user' }), USER_ABORT_BEFORE_FIRST_EVENT_MS);
    const err = await pending.catch((e) => e);
    expect(err).toBeInstanceOf(ExternalAbortError);
    expect(err).not.toBeInstanceOf(LLMTimeoutError);
  });

  it('call() 完整事件流超过 timeoutMs → LLMTimeoutError（总时长语义不变）', async () => {
    // 与 stream 成功用例同形滴流；call 保留 wall-clock 总时长保护，100ms 触发。
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_u: string, init: RequestInit) =>
      dripSseResponse(openaiSse(dripFrames()), [20, 250, 250, 5], init.signal ?? undefined)));
    const adapter = createLLMProvider(baseConfig({ timeoutMs: 100 }));
    const err = await adapter.call({ messages: [{ role: 'user', content: 'hi' }] }).catch((e) => e);
    expect(err).toBeInstanceOf(LLMTimeoutError);
    expect((err as LLMTimeoutError).context).toMatchObject({ provider: 'test-provider', timeoutMs: 100 });
  });
});

describe('PiAiAdapter — anthropic-messages 协议', () => {
  function anthropicSse(events: Array<[string, unknown]>): string[] {
    return events.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify(data)}`);
  }

  it('text + thinking(含 signature) + tool_use + usage 全要素', async () => {
    const sse = anthropicSse([
      ['message_start', { type: 'message_start', message: { id: 'm1', usage: { input_tokens: 10 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'ponder' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-abc' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'answer' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 1 }],
      ['content_block_start', { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'lookup' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"q":' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"x"}' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 2 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 22 } }],
      ['message_stop', { type: 'message_stop' }],
    ]);
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(sse));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = createLLMProvider(baseConfig({ apiFormat: 'anthropic', baseUrl: 'https://api.anthropic.test' }));
    const chunks = await collectChunks(adapter);

    expect(chunks).toContainEqual({ type: 'thinking_delta', delta: 'ponder' });
    expect(chunks).toContainEqual({ type: 'thinking_signature', signature: 'sig-abc' });
    expect(chunks).toContainEqual({ type: 'text_delta', delta: 'answer' });
    expect(chunks.find((c) => c.type === 'tool_use_start')?.toolUse).toMatchObject({ id: 'toolu_1', name: 'lookup' });
    const toolInput = chunks.filter((c) => c.type === 'tool_use_delta').map((d) => d.toolUse?.partialInput ?? '').join('');
    expect(JSON.parse(toolInput)).toEqual({ q: 'x' });
    const done = chunks.find((c) => c.type === 'done');
    expect(done?.stopReason).toBe('tool_use');
    expect(done?.usage).toMatchObject({ inputTokens: 10, outputTokens: 22 });

    // anthropic 端点与 auth 头（pi-ai 会追加 ?beta=true 查询参数）
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/^https:\/\/api\.anthropic\.test\/v1\/messages/);
    const headers = new Headers(init.headers);
    expect(headers.get('x-api-key')).toBe('sk-test-key');
  });

  it('call() thinking 块带 signature 回放字段', async () => {
    const sse = anthropicSse([
      ['message_start', { type: 'message_start', message: { id: 'm1', usage: { input_tokens: 3 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 't' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'S' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'done' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 1 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }],
      ['message_stop', { type: 'message_stop' }],
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(sse)));
    const adapter = createLLMProvider(baseConfig({ apiFormat: 'anthropic', baseUrl: 'https://api.anthropic.test' }));
    const response = await adapter.call({ messages: [{ role: 'user', content: 'hi' }] });
    expect(response.content).toEqual([
      { type: 'thinking', thinking: 't', signature: 'S' },
      { type: 'text', text: 'done' },
    ]);
    expect(response.stop_reason).toBe('end_turn');
  });
});

describe('PiAiAdapter — model 解析与 catalog', () => {
  it('catalog 命中（deepseek/deepseek-v4-pro）：api 与 baseUrl 取 catalog 权威', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(openaiSse(openaiTextFrames('ok'))));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = createLLMProvider(baseConfig({
      name: 'deepseek',
      model: 'deepseek-v4-pro',
      baseUrl: 'https://api.deepseek.com',
      piAiProvider: 'deepseek',
    }));
    await adapter.call({ messages: [{ role: 'user', content: 'hi' }] });
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://api.deepseek.com/chat/completions');
  });

  it('catalog 命中但用户显式 baseUrl → baseUrl 覆盖生效', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(openaiSse(openaiTextFrames('ok'))));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = createLLMProvider(baseConfig({
      name: 'deepseek',
      model: 'deepseek-v4-pro',
      baseUrl: 'https://proxy.example.com/v1',
      piAiProvider: 'deepseek',
    }));
    await adapter.call({ messages: [{ role: 'user', content: 'hi' }] });
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://proxy.example.com/v1/chat/completions');
  });

  it('catalog model api 权威于 apiFormat 映射（gpt-4o → openai-responses 端点）', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: { message: 'x' } }, 400));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = createLLMProvider(baseConfig({
      name: 'openai',
      model: 'gpt-4o',
      baseUrl: 'https://api.openai.com/v1',
      piAiProvider: 'openai',
      apiFormat: 'openai', // 显式映射是 openai-completions；catalog 权威为 openai-responses
    }));
    await adapter.call({ messages: [{ role: 'user', content: 'hi' }] })
      .catch(() => { /* silent: 本用例只观测请求 URL（api 权威性），错误路径另案覆盖 */ });
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://api.openai.com/v1/responses');
  });

  it('catalog 未命中 + 无 baseUrl → loud LLMError（不做协议/地址猜测）', () => {
    const adapter = createLLMProvider(baseConfig({ baseUrl: undefined, model: 'mystery-model' }));
    return expect(adapter.call({ messages: [{ role: 'user', content: 'hi' }] }))
      .rejects.toThrow(/base URL is required/);
  });

  it('catalog 未命中 + 显式 baseUrl → 自建 Model（apiFormat 显式协议）', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(openaiSse(openaiTextFrames('ok'))));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = createLLMProvider(baseConfig({
      name: 'custom-openai',
      model: 'my-ft-model',
      baseUrl: 'https://my-gateway.local/v1',
      piAiProvider: undefined,
    }));
    await adapter.call({ messages: [{ role: 'user', content: 'hi' }] });
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://my-gateway.local/v1/chat/completions');
  });

  it('Phase 1926 Step D：catalog ambient provider 不再 loud out-of-scope —— builtin provider 接管请求', async () => {
    // mistral（mistral-conversations，Step C 旧边界外 api）：baseUrl 覆盖后经全局
    // fetch 发请求（Step C 会 loud "not supported"）；fetch stub 401 → LLMAuthError。
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message: 'Unauthorized' }, 401));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = createLLMProvider(baseConfig({
      name: 'mistral',
      model: 'mistral-large-latest',
      baseUrl: 'https://api.test.invalid/v1',
      piAiProvider: 'mistral',
      apiFormat: undefined,
    }));
    await expect(adapter.call({ messages: [{ role: 'user', content: 'hi' }] }))
      .rejects.toBeInstanceOf(LLMAuthError);
    expect(fetchMock).toHaveBeenCalled();
  });

  it('Phase 1926 Step D：azure-openai-responses（catalog baseUrl 空 + config.baseUrl 覆盖）走 builtin provider', async () => {
    // azure catalog model baseUrl 为空（deployment 由用户给）——config.baseUrl 覆盖后
    // 经全局 fetch 发请求；fetch stub 401 → LLMAuthError（证明路由+auth 装配完成）
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: { message: 'unauthorized' } }, 401));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = createLLMProvider(baseConfig({
      name: 'azure',
      model: 'gpt-4.1',
      baseUrl: 'https://my-deployment.openai.azure.com',
      piAiProvider: 'azure-openai-responses',
      apiFormat: undefined,
    }));
    await expect(adapter.call({ messages: [{ role: 'user', content: 'hi' }] }))
      .rejects.toBeInstanceOf(LLMAuthError);
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('https://my-deployment.openai.azure.com');
  });

  it('Phase 1926 Step D：OAuth-only provider 配 api_key → loud LLMError（不静默忽略 override）', async () => {
    const adapter = createLLMProvider(baseConfig({
      name: 'codex',
      model: 'gpt-5.5',
      piAiProvider: 'openai-codex',
      apiFormat: undefined,
      apiKey: 'sk-should-not-be-here',
    }));
    await expect(adapter.call({ messages: [{ role: 'user', content: 'hi' }] }))
      .rejects.toThrow(/OAuth-only/);
  });
});

describe('PiAiAdapter — Google 族退化（设计稿 G1 登记）', () => {
  it('不注入 fetch 且 429 文本判定为 LLMRateLimitError（无 retryAfter）', async () => {
    // google-generative-ai 走 genai SDK 形态；mock 其 REST 端点返回 429 JSON
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonResponse({ error: { code: 429, message: 'slow down', status: 'RESOURCE_EXHAUSTED' } }, 429),
    ));
    const adapter = createLLMProvider(baseConfig({
      apiFormat: 'gemini',
      model: 'gemini-2.5-pro',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      piAiProvider: 'google',
    }));
    try {
      await adapter.call({ messages: [{ role: 'user', content: 'hi' }] });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(LLMRateLimitError);
      // 退化登记：Google 族 HTTP status/retry-after 不可得 → retryAfter 恒 undefined
      expect((err as InstanceType<typeof LLMRateLimitError>).retryAfter).toBeUndefined();
    }
  });
});

describe('PiAiAdapter — wire 映射', () => {
  it('tool_result 恢复 toolName；dropThinkingBlocks 剥离 thinking；system 折叠', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(openaiSse(openaiTextFrames('ok'))));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = createLLMProvider(baseConfig({ dropThinkingBlocks: true }));
    await adapter.call({
      system: 'SYS',
      messages: [
        { role: 'assistant', content: [
          { type: 'thinking', thinking: 'secret-thought', signature: 'sig' },
          { type: 'tool_use', id: 'call_1', name: 'do_thing', input: { x: 1 } },
        ] },
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: 'result-text' },
        ] },
        { role: 'user', content: 'next' },
      ],
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toBe('SYS');
    const assistant = body.messages[1];
    // thinking 被剥离；tool call 保留
    expect(JSON.stringify(assistant)).not.toContain('secret-thought');
    const toolMsg = body.messages[2];
    expect(toolMsg.role).toBe('tool');
    expect(toolMsg.tool_call_id).toBe('call_1');
    // 注：wire 层已恢复 toolName 交给 pi-ai；openai-completions 序列化仅在
    // compat.requiresToolResultName 时携带 name 字段，缺省 compat 不携带
  });
});
