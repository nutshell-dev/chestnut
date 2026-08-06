/**
 * StreamEvent 类型契约测试（phase 1316）。
 *
 * - LLMEvent['type'] ⊆ StreamEventType（编译期）
 * - 写端对象字面量匹配 StreamEventMap（编译期样例）
 * - STREAM_EVENT_NAMES 成员数基线（运行时）
 */

import { describe, expect, it } from 'vitest';
import { STREAM_EVENT_NAMES, type StreamEvent, type StreamEventType } from '../../../src/foundation/stream/index.js';
import type { LLMEvent } from '../../../src/foundation/llm-orchestrator/types.js';

type LLMEventType = LLMEvent['type'];
type Assert<T extends true> = T;
type _LLMEventSubset = Assert<LLMEventType extends StreamEventType ? true : false>;

// 写端样例编译断言（覆盖 agent-executor / event-loop / llm-orchestrator 代表类型）
const _thinkingDelta: StreamEvent = { ts: 1, type: STREAM_EVENT_NAMES.THINKING_DELTA, delta: 'x' };
const _toolResult: StreamEvent = {
  ts: 1,
  type: STREAM_EVENT_NAMES.TOOL_RESULT,
  name: 'test-tool',
  tool_use_id: 'tu-1',
  success: true,
  summary: 'ok',
  step: 1,
  maxSteps: 3,
};
const _llmRetryWaiting: StreamEvent = {
  ts: 1,
  type: STREAM_EVENT_NAMES.LLM_RETRY_WAITING,
  stage: 'retry',
  action: 'scheduled',
  attempt: 1,
  maxAttempts: 3,
  delayMs: 100,
  resumeAt: '2026-08-06T00:00:00.000Z',
  errorClass: 'transient',
};
const _providerAttemptFailed: StreamEvent = {
  ts: 1,
  type: STREAM_EVENT_NAMES.PROVIDER_ATTEMPT_FAILED,
  provider: 'p',
  attempt: 0,
  maxAttempts: 3,
  error: 'boom',
  errorClass: 'transient',
  userActionHint: 'retry',
};
const _taskStarted: StreamEvent = {
  ts: 1,
  type: STREAM_EVENT_NAMES.TASK_STARTED,
  taskId: 't1',
  taskKind: 'spawn_subagent',
  silent: false,
  fullTaskId: 'full-t1',
};
void _thinkingDelta;
void _toolResult;
void _llmRetryWaiting;
void _providerAttemptFailed;
void _taskStarted;

describe('StreamEvent contract', () => {
  it('STREAM_EVENT_NAMES 成员数 == 50（StreamEventType 基线）', () => {
    const keys = Object.keys(STREAM_EVENT_NAMES);
    expect(keys.length).toBe(50);
  });

  it('LLMEvent 27 个 type 字面量均存在于 STREAM_EVENT_NAMES', () => {
    // 运行时双重检查：确保 LLMEvent 的所有 type 值都被 STREAM_EVENT_NAMES 覆盖。
    const names = new Set(Object.values(STREAM_EVENT_NAMES));
    const llmEventTypes: LLMEventType[] = [
      'provider_attempt_failed',
      'retry_scheduled',
      'provider_exhausted',
      'fallback_switched',
      'breaker_opened',
      'breaker_half_open',
      'breaker_closed',
      'healthcheck_failed',
      'stream_reset',
      'stream_parse_error',
      'tool_arg_parse_error',
      'idle_failover_triggered',
      'stream_idle_probe_attempted',
      'stream_idle_probe_succeeded',
      'context_exceeded_failover',
      'context_exceeded_throwthrough',
      'permanent_skip_retry',
      'hedge_started',
      'hedge_primary_recovered',
      'hedge_primary_post_first_chunk_failure',
      'hedge_fallback_committed',
      'hedge_primary_succeeded_after_race_lost',
      'all_providers_context_exceeded',
      'race_loser_cleaned',
      'sdk_client_cache_hit',
      'sdk_client_cache_miss',
      'provider_close_failed',
    ];
    for (const t of llmEventTypes) {
      expect(names.has(t)).toBe(true);
    }
  });
});
