/**
 * launcher-event-mapper tests（phase 2001 Step B 引入，phase 2002 Step C 按 claw bar 重做）
 *
 * LauncherActivityMapper 单元语义：按 trace 累计 thinking/裸 text 摘要（单行净化+尾部截断），
 * tool/provider 短标签，send_content_end 不清除，turn_error → error 保留可读错误行。
 * 边界：摘要 ≤240 字符、错误 ≤160 字符、tool 不带 input、error 不带密钥/完整 payload。
 */

import { describe, it, expect } from 'vitest';
import { LauncherActivityMapper, LauncherEventMapper } from '../../src/cli/launcher-envelope-producer.js';

describe('LauncherActivityMapper', () => {
  it('turn/llm/tool 事件映射为 processing 短标签', () => {
    const mapper = new LauncherActivityMapper();
    expect(mapper.map({ ts: 1, type: 'turn_start', sources: [] } as never))
      .toEqual({ phase: 'processing', label: 'turn' });
    expect(mapper.map({ ts: 2, type: 'llm_start', trace_id: 't1' } as never))
      .toEqual({ phase: 'processing', label: 'provider', traceId: 't1' });
    expect(mapper.map({ ts: 3, type: 'tool_call', name: 'search', tool_use_id: 'tu1', trace_id: 't1' } as never))
      .toEqual({ phase: 'processing', label: 'tool', detail: 'search', traceId: 't1' });
    expect(mapper.map({ ts: 4, type: 'tool_result', name: 'search', tool_use_id: 'tu1', success: true, summary: 'ok', step: 1, maxSteps: 5, trace_id: 't1' } as never))
      .toEqual({ phase: 'processing', label: 'tool_result', detail: 'search', traceId: 't1' });
  });

  it('thinking_delta 按 trace 累计单行摘要：换行折空格、流式更新', () => {
    const mapper = new LauncherActivityMapper();
    expect(mapper.map({ ts: 1, type: 'thinking_delta', delta: '先想\n第一步', trace_id: 't1' } as never))
      .toEqual({ phase: 'processing', label: 'thinking', detail: '先想 第一步', traceId: 't1' });
    expect(mapper.map({ ts: 2, type: 'thinking_delta', delta: '，再验证', trace_id: 't1' } as never))
      .toEqual({ phase: 'processing', label: 'thinking', detail: '先想 第一步，再验证', traceId: 't1' });
  });

  it('裸 text_delta 同规则累计（label=text），不进入消息流', () => {
    const mapper = new LauncherActivityMapper();
    const eventMapper = new LauncherEventMapper();
    const event = { ts: 1, type: 'text_delta', delta: '起草正文', trace_id: 't1' } as never;
    expect(mapper.map(event))
      .toEqual({ phase: 'processing', label: 'text', detail: '起草正文', traceId: 't1' });
    expect(eventMapper.map(event)).toBeNull(); // 裸 text_delta 仍不是 Motion 聊天消息（phase 1990 决策）
  });

  it('摘要尾部截断（≤240 字符）；kind 切换重新开始累计', () => {
    const mapper = new LauncherActivityMapper();
    const long = '长'.repeat(300);
    const a = mapper.map({ ts: 1, type: 'thinking_delta', delta: long, trace_id: 't1' } as never);
    expect(a?.detail).toHaveLength(240);
    // thinking → text 切换：摘要从新 kind 重新累计（不拼接旧 kind）
    const b = mapper.map({ ts: 2, type: 'text_delta', delta: '新正文', trace_id: 't1' } as never);
    expect(b).toEqual({ phase: 'processing', label: 'text', detail: '新正文', traceId: 't1' });
  });

  it('多 trace 摘要各自独立（交错不互相串缓冲——phase 2000 交错教训）', () => {
    const mapper = new LauncherActivityMapper();
    expect(mapper.map({ ts: 1, type: 'thinking_delta', delta: '甲一', trace_id: 'A' } as never)?.detail).toBe('甲一');
    expect(mapper.map({ ts: 2, type: 'thinking_delta', delta: '乙一', trace_id: 'B' } as never)?.detail).toBe('乙一');
    expect(mapper.map({ ts: 3, type: 'thinking_delta', delta: '甲二', trace_id: 'A' } as never)?.detail).toBe('甲一甲二');
    expect(mapper.map({ ts: 4, type: 'thinking_delta', delta: '乙二', trace_id: 'B' } as never)?.detail).toBe('乙一乙二');
  });

  it('tool 事件只带工具名，不带 input/参数', () => {
    const mapper = new LauncherActivityMapper();
    const input = mapper.map({ ts: 1, type: 'tool_use_input', name: 'search', tool_use_id: 'tu1', input: { query: 'secret' }, trace_id: 't1' } as never);
    expect(input).toEqual({ phase: 'processing', label: 'tool', detail: 'search', traceId: 't1' });
    expect(JSON.stringify(input)).not.toContain('secret');
  });

  it('provider 事件更新短标签（provider_failed/failover/fallback/retry）', () => {
    const mapper = new LauncherActivityMapper();
    expect(mapper.map({ ts: 1, type: 'provider_failed', provider: 'kimi', model: 'k2', error: 'timeout 全文不应外发', trace_id: 't1' } as never))
      .toEqual({ phase: 'processing', label: 'provider', detail: 'kimi', traceId: 't1' });
    expect(mapper.map({ ts: 2, type: 'fallback_switched', from: 'kimi', to: 'backup', reason: 'r', trace_id: 't1' } as never))
      .toEqual({ phase: 'processing', label: 'provider', detail: 'backup', traceId: 't1' });
    expect(mapper.map({ ts: 3, type: 'llm_retry_waiting', stage: 'retry', action: 'scheduled', attempt: 2, maxAttempts: 5, delayMs: 1000, resumeAt: '', errorClass: 'network', trace_id: 't1' } as never))
      .toEqual({ phase: 'processing', label: 'provider', detail: 'retry 2/5', traceId: 't1' });
  });

  it('send_content_delta/send_content_end 均映射 responding（send 完成不结束 turn）', () => {
    const mapper = new LauncherActivityMapper();
    expect(mapper.map({ ts: 1, type: 'send_content_delta', delta: 'x', trace_id: 'r1' } as never))
      .toEqual({ phase: 'responding', traceId: 'r1' });
    expect(mapper.map({ ts: 2, type: 'send_content_end', trace_id: 'r1' } as never))
      .toEqual({ phase: 'responding', traceId: 'r1' });
  });

  it('turn_end/turn_interrupted 映射 idle 并清理摘要缓冲；turn_error 映射 error（保留可读错误行，不伪装 idle）', () => {
    const mapper = new LauncherActivityMapper();
    mapper.map({ ts: 1, type: 'thinking_delta', delta: '旧摘要', trace_id: 't1' } as never);
    expect(mapper.map({ ts: 2, type: 'turn_error', error: 'network timeout\nprovider kimi 不可用', trace_id: 't1' } as never))
      .toEqual({ phase: 'error', label: 'turn', detail: 'network timeout provider kimi 不可用', traceId: 't1' });
    // turn 终止清理缓冲：同 trace 新 turn 的摘要不残留旧内容
    mapper.map({ ts: 3, type: 'turn_start', trace_id: 't1' } as never);
    expect(mapper.map({ ts: 4, type: 'thinking_delta', delta: '全新', trace_id: 't1' } as never)?.detail).toBe('全新');
    expect(mapper.map({ ts: 5, type: 'turn_end', trace_id: 't1' } as never))
      .toEqual({ phase: 'idle', traceId: 't1' });
    expect(mapper.map({ ts: 6, type: 'turn_interrupted', cause: 'user', trace_id: 't2' } as never))
      .toEqual({ phase: 'idle', traceId: 't2' });
  });

  it('turn_error 摘要截断（≤160 字符）且不携带非字符串 error', () => {
    const mapper = new LauncherActivityMapper();
    const long = mapper.map({ ts: 1, type: 'turn_error', error: `前缀 ${'错'.repeat(300)}`, trace_id: 't1' } as never);
    expect(long?.phase).toBe('error');
    expect(long?.detail?.length).toBeLessThanOrEqual(160);
    expect(long?.detail).toContain('前缀'); // 错误摘保留开头（分类/可行动提示在前）
    expect(mapper.map({ ts: 2, type: 'turn_error', error: { nested: 'secret' }, trace_id: 't1' } as never))
      .toEqual({ phase: 'error', label: 'turn', traceId: 't1' }); // 非字符串 error 不带 detail
  });

  it('无关事件（provider_info/recovery 等）不映射', () => {
    const mapper = new LauncherActivityMapper();
    expect(mapper.map({ ts: 1, type: 'provider_info', name: 'kimi' } as never)).toBeNull();
    expect(mapper.map({ ts: 2, type: 'recovery_scheduled' } as never)).toBeNull();
    expect(mapper.map({ ts: 3, type: 'thinking_delta', delta: '', trace_id: 't1' } as never)).toBeNull();
  });

  it('activity 与消息 event 可同源并存：send_content_delta 同时驱动两者', () => {
    const eventMapper = new LauncherEventMapper();
    const activityMapper = new LauncherActivityMapper();
    const event = { ts: 1, type: 'send_content_delta', delta: '你好', trace_id: 'r1' } as never;
    expect(eventMapper.map(event)).toEqual({ messageId: 'reply-r1', role: 'motion', text: '你好' });
    expect(activityMapper.map(event)).toEqual({ phase: 'responding', traceId: 'r1' });
  });
});
