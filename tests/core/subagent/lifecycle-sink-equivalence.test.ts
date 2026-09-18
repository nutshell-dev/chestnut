/**
 * phase 1858 Step K (SA-D10): lifecycle sink adapter 等价矩阵。
 *
 * 守约：sink 结构化方法 → 真 AuditLog 的 (event, ...cols) 逐列一致（事件字符串 /
 * 列名 / 列顺序 / 列值），即「以 sink 替换直写」对审计行 0 漂移。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { createSubAgentLifecycleSink } from '../../../src/core/subagent/lifecycle-sink.js';

const AGENT_ID = 'agent-eq';

function makeSink() {
  const calls: unknown[][] = [];
  const auditWriter = {
    write: vi.fn((event: string, ...cols: unknown[]) => { calls.push([event, ...cols]); }),
  };
  const sink = createSubAgentLifecycleSink({
    auditWriter: auditWriter as any,
    agentId: AGENT_ID,
    traceId: 'trace-eq' as any,
    currentContractId: 'contract-eq',
  });
  return { sink, calls, auditWriter };
}

describe('phase 1858 Step K: lifecycle sink adapter 等价矩阵（逐列一致）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('turnStart / turnEnd → react-loop 事件、零列', () => {
    const { sink, calls } = makeSink();
    sink.turnStart();
    sink.turnEnd();
    expect(calls).toEqual([
      ['turn_start'],
      ['turn_end'],
    ]);
  });

  it('llmCall / llmError → 列顺序与旧直写一致', () => {
    const { sink, calls } = makeSink();
    sink.llmCall({ model: 'm1', inputTokens: 10, outputTokens: 20, latencyMs: 30 });
    sink.llmError({ model: 'm1', error: 'boom', latencyMs: 40 });
    expect(calls).toEqual([
      ['llm_call', 'm1', 'in=10', 'out=20', 'latency_ms=30'],
      ['llm_error', 'm1', 'error=boom', 'latency_ms=40'],
    ]);
  });

  it('turnInterrupted 五 cause 分支逐位一致', () => {
    const { sink, calls } = makeSink();
    sink.turnInterrupted({ cause: 'turn_timeout', ms: 5000 });
    sink.turnInterrupted({ cause: 'idle_timeout', ms: 1000 });
    sink.turnInterrupted({ cause: 'user_interrupt' });
    sink.turnInterrupted({ cause: 'priority_inbox' });
    sink.turnInterrupted({ cause: 'external', type: 'external' });
    sink.turnInterrupted({ cause: 'external' });
    expect(calls).toEqual([
      ['turn_interrupted', 'cause=turn_timeout', 'turn_timeout_ms=5000'],
      ['turn_interrupted', 'cause=idle_timeout', 'idle_timeout_ms=1000'],
      ['turn_interrupted', 'cause=user_interrupt'],
      ['turn_interrupted', 'cause=priority_inbox'],
      ['turn_interrupted', 'cause=external', 'type=external'],
      ['turn_interrupted', 'cause=external'],
    ]);
  });

  it('turnError → 单列 error=', () => {
    const { sink, calls } = makeSink();
    sink.turnError({ error: 'kaboom' });
    expect(calls).toEqual([['turn_error', 'error=kaboom']]);
  });

  it('stepCompleteFailed / persistFailed(±stage) / logAppendFailed / timeoutRejection', () => {
    const { sink, calls } = makeSink();
    sink.stepCompleteFailed({ error: 'e1' });
    sink.persistFailed({ error: 'e2' });
    sink.persistFailed({ stage: 'artifact_completeness', error: 'e3' });
    sink.logAppendFailed({ path: '/tmp/log', error: 'e4' });
    sink.timeoutRejection({ reason: 'subagent_run timeout' });
    expect(calls).toEqual([
      ['subagent_step_complete_failed', `agentId=${AGENT_ID}`, 'error=e1'],
      ['subagent_persist_failed', `agentId=${AGENT_ID}`, 'error=e2'],
      ['subagent_persist_failed', `agentId=${AGENT_ID}`, 'stage=artifact_completeness', 'error=e3'],
      ['subagent_log_append_failed', `agentId=${AGENT_ID}`, 'path=/tmp/log', 'error=e4'],
      ['subagent_timeout_rejection', `agentId=${AGENT_ID}`, 'reason=subagent_run timeout'],
    ]);
  });

  it('ghostCallbackAfterTurnEnd → agentId + event 列', () => {
    const { sink, calls } = makeSink();
    sink.ghostCallbackAfterTurnEnd({ event: 'text_delta' });
    expect(calls).toEqual([
      ['ghost_callback_after_turn_end', `agentId=${AGENT_ID}`, 'event=text_delta'],
    ]);
  });

  it('toolCallInput → contract/trace 由 adapter 绑定、列序逐位一致', () => {
    const { sink, calls } = makeSink();
    sink.toolCallInput({ name: 'summon', toolUseId: 'tu1', step: 2, argsSize: 17 });
    expect(calls).toEqual([
      ['tool_call_input', 'summon', 'tool_use_id=tu1', 'step=2', 'contract_id=contract-eq', 'trace_id=trace-eq', 'args_size=17'],
    ]);
  });

  it('toolResult → status/content_size/summary 列逐位一致（含截断同源）', () => {
    const { sink, calls } = makeSink();
    sink.toolResult({ name: 'summarize', toolUseId: 'tu2', step: 3, success: true, content: 'ok!' });
    sink.toolResult({ name: 'summarize', toolUseId: 'tu3', step: 4, success: false, content: 'bad' });
    expect(calls).toEqual([
      ['tool_result', 'summarize', 'tool_use_id=tu2', 'step=3', 'contract_id=contract-eq', 'trace_id=trace-eq', 'status=ok', 'content_size=3', 'summary=ok!'],
      ['tool_result', 'summarize', 'tool_use_id=tu3', 'step=4', 'contract_id=contract-eq', 'trace_id=trace-eq', 'status=err', 'content_size=3', 'summary=bad'],
    ]);
  });

  it('partialAssistantDiscarded → trace_id 列忠实保留历史空值 + agent_id 绑定', () => {
    const { sink, calls } = makeSink();
    sink.partialAssistantDiscarded({
      cause: 'idle_timeout',
      toolUseCount: 2,
      hasText: true,
      hasThinking: false,
      startTs: 100,
      endTs: 200,
      errMessage: 'partial boom',
    });
    expect(calls).toEqual([
      ['partial_assistant_discarded', 'cause=idle_timeout', 'tool_use_count=2', 'has_text=true', 'has_thinking=false', 'ts_range=100-200', 'trace_id=', `agent_id=${AGENT_ID}`, 'err=partial boom'],
    ]);
  });

  it('stepsInvariantViolated → idx 先于 actual（tools_element 变体列序）', () => {
    const { sink, calls } = makeSink();
    sink.stepsInvariantViolated({ kind: 'step_invalid', actual: '-1' });
    sink.stepsInvariantViolated({ kind: 'tools_element_not_string', idx: 1, actual: 'number' });
    expect(calls).toEqual([
      ['subagent_steps_invariant_violated', 'kind=step_invalid', `agentId=${AGENT_ID}`, 'actual=-1'],
      ['subagent_steps_invariant_violated', 'kind=tools_element_not_string', `agentId=${AGENT_ID}`, 'idx=1', 'actual=number'],
    ]);
  });

  it('artifactCrossSource ok / mismatch / skipped 逐位一致', () => {
    const { sink, calls } = makeSink();
    sink.artifactCrossSourceOk({ textEndCount: 1, lastRole: 'assistant' });
    sink.artifactCrossSourceMismatch({ textEndCount: 2, lastRole: 'user' });
    sink.artifactCrossSourceSkipped({ kind: 'ac4_skip', reason: 'message_load_failed', error: 'EIO' });
    expect(calls).toEqual([
      ['subagent_artifact_cross_source_ok', 'kind=ac4_ok', `agentId=${AGENT_ID}`, 'textend_count=1', 'last_role=assistant'],
      ['subagent_artifact_cross_source_mismatch', 'kind=ac4_textend_without_last_assistant_text', `agentId=${AGENT_ID}`, 'textend_count=2', 'last_role=user'],
      ['subagent_artifact_cross_source_skipped', 'kind=ac4_skip', `agentId=${AGENT_ID}`, 'reason=message_load_failed', 'error=EIO'],
    ]);
  });

  it('runReactAbortStillRunning / captureProtocolMalformed 逐位一致', () => {
    const { sink, calls } = makeSink();
    sink.runReactAbortStillRunning({ settleMs: 100 });
    sink.captureProtocolMalformed({ tool: 'custom_result', reason: 'result field must be string, got number' });
    expect(calls).toEqual([
      ['subagent_runreact_abort_still_running', `agentId=${AGENT_ID}`, 'settle_ms=100'],
      ['subagent_capture_protocol_malformed', `agentId=${AGENT_ID}`, 'tool=custom_result', 'reason=result field must be string, got number'],
    ]);
  });

  it('模块内 helpers 不直接 import 完整 AuditLog（K 收口机械守）', () => {
    // 允许面：lifecycle-sink.ts（adapter 归属）+ noop-writers.ts（foundation noop 归属）
    const moduleFiles = [
      'agent.ts',
      'error-classifier.ts',
      'timeout-controller.ts',
      'artifact-cross-source-audit.ts',
      'stream-callbacks.ts',
      'invariants.ts',
      'audit-events.ts',
    ];
    for (const file of moduleFiles) {
      const src = readFileSync(path.join(process.cwd(), 'src/core/subagent', file), 'utf-8');
      expect(src, `${file} 不应 import AuditLog（消费面应为 lifecycle sink）`).not.toMatch(/import[^\n]*AuditLog/);
    }
  });

  it('守卫：审计写抛 → 不逃逸 + stderr 最后手段一行（含事件名）', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const auditWriter = { write: vi.fn(() => { throw new Error('channel down'); }) };
    const sink = createSubAgentLifecycleSink({ auditWriter: auditWriter as any, agentId: AGENT_ID });

    expect(() => sink.turnError({ error: 'x' })).not.toThrow();

    const stderrLines = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(stderrLines).toContain('[subagent] audit write failed');
    expect(stderrLines).toContain('turn_error');
    expect(stderrLines).toContain('channel down');
    stderrSpy.mockRestore();
  });
});
