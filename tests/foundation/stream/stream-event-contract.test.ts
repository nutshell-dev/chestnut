/**
 * StreamEvent 类型契约测试（phase 1316；phase 1321 分层收窄 50→40）。
 *
 * - LLMEvent['type'] ⊆ StreamEventType（编译期 + 运行时）
 * - 写端对象字面量匹配协议层 StreamEvent / CLI 汇总 CliStreamEvent（编译期样例）
 * - STREAM_EVENT_NAMES 成员数基线 40（运行时）+ 上层业务事件不混入协议层
 */

import { describe, expect, it } from 'vitest';
import { STREAM_EVENT_NAMES, type StreamEvent, type StreamEventType } from '../../../src/foundation/stream/index.js';
import { STREAM_AGENT_EVENTS } from '../../../src/core/agent-executor/index.js';
import { STREAM_TASK_EVENTS } from '../../../src/core/async-task-system/index.js';
import type { CliStreamEvent } from '../../../src/cli/commands/stream-event-types.js';
import type { LLMEvent } from '../../../src/foundation/llm-orchestrator/types.js';

type LLMEventType = LLMEvent['type'];
type Assert<T extends true> = T;
type _LLMEventSubset = Assert<LLMEventType extends StreamEventType ? true : false>;

// 写端样例编译断言（协议层：StreamEvent 协议基础；上层：CLI 汇总判别联合）
const _thinkingDelta: StreamEvent = { ts: 1, type: STREAM_EVENT_NAMES.THINKING_DELTA, delta: 'x' };
const _toolResult: CliStreamEvent = {
  ts: 1,
  type: STREAM_AGENT_EVENTS.TOOL_RESULT,
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
const _taskStarted: CliStreamEvent = {
  ts: 1,
  type: STREAM_TASK_EVENTS.TASK_STARTED,
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
  it('STREAM_EVENT_NAMES 成员数 == 40（协议层基线，phase 1321 收窄 50→40）', () => {
    const keys = Object.keys(STREAM_EVENT_NAMES);
    expect(keys.length).toBe(40);
  });

  it('协议层不含上层业务事件（分层拆件：agent 6 / task 3 / daemon 1 归各模块 const）', () => {
    expect(STREAM_EVENT_NAMES).not.toHaveProperty('TURN_START');
    expect(STREAM_EVENT_NAMES).not.toHaveProperty('LLM_START');
    expect(STREAM_EVENT_NAMES).not.toHaveProperty('TOOL_RESULT');
    expect(STREAM_EVENT_NAMES).not.toHaveProperty('TURN_END');
    expect(STREAM_EVENT_NAMES).not.toHaveProperty('TURN_INTERRUPTED');
    expect(STREAM_EVENT_NAMES).not.toHaveProperty('TURN_ERROR');
    expect(STREAM_EVENT_NAMES).not.toHaveProperty('TASK_STARTED');
    expect(STREAM_EVENT_NAMES).not.toHaveProperty('TASK_COMPLETED');
    expect(STREAM_EVENT_NAMES).not.toHaveProperty('TASK_ATTEMPT_START');
    expect(STREAM_EVENT_NAMES).not.toHaveProperty('DAEMON_STARTED');
    // 改名消歧：send_content_* 替代 user_reply_*（send 工具 input 流是 LLM 输出、非用户来源事件）
    expect(STREAM_EVENT_NAMES).not.toHaveProperty('USER_REPLY_DELTA');
    expect(STREAM_EVENT_NAMES).not.toHaveProperty('USER_REPLY_END');
  });

  it('LLMEvent 27 个 type 字面量均存在于 STREAM_EVENT_NAMES', () => {
    // 运行时双重检查：确保 LLMEvent 的所有 type 值都被 STREAM_EVENT_NAMES 覆盖。
    const names = new Set<string>(Object.values(STREAM_EVENT_NAMES));
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
