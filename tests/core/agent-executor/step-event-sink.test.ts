/**
 * phase 1857 Step I (SE-D9): createStepExecutorEventSink caller adapter 等价矩阵。
 *
 * 锁定：结构化事件 → 展示（callbacks 恰一次）+ 持久化（audit 行逐列与
 * 迁移前模块内直写一致，contract_id/trace_id 绑定在 adapter）。
 */

import { describe, it, expect, vi } from 'vitest';
import { createStepExecutorEventSink } from '../../../src/core/step-executor/index.js';
import type { StepCallbacks } from '../../../src/core/step-executor/index.js';

function makeAudit() {
  const entries: unknown[][] = [];
  const audit = {
    write: (...cols: unknown[]) => { entries.push(cols); },
    message: (s: string) => `msg(${s})`,
    preview: (s: string) => `prev(${s})`,
    summary: (s: string) => s,
  };
  return { audit, entries };
}

const BINDING = { contractId: 'c-1', traceId: 't-9' };

describe('phase 1857 Step I: step-event-sink adapter 等价矩阵', () => {
  it('toolInputParseFailed → 展示 onToolInputParseError + 审计行逐列保持', () => {
    const { audit, entries } = makeAudit();
    const onToolInputParseError = vi.fn();
    const sink = createStepExecutorEventSink({ callbacks: { onToolInputParseError } as StepCallbacks, auditWriter: audit as never, ...BINDING });

    sink.toolInputParseFailed({ toolName: 'edit', toolUseId: 'tu1', reason: 'parse_error', summary: '{bad' });

    expect(onToolInputParseError).toHaveBeenCalledWith('edit', 'tu1', '{bad');
    expect(entries).toEqual([['tool_input_parse_failed', 'edit', 'tu1', 'reason=parse_error', 'summary=msg({bad)']]);
  });

  it('toolExecutionFailed → 展示 + 审计行（errorType/errorMsg 截断归 adapter）', () => {
    const { audit, entries } = makeAudit();
    const onToolExecutionFailed = vi.fn();
    const sink = createStepExecutorEventSink({ callbacks: { onToolExecutionFailed } as StepCallbacks, auditWriter: audit as never, ...BINDING });

    sink.toolExecutionFailed({ toolName: 'exec', toolUseId: 'tu2', errorType: 'ToolError', errorMsg: 'boom' });

    expect(onToolExecutionFailed).toHaveBeenCalledWith('exec', 'tu2', 'ToolError', 'boom');
    expect(entries).toEqual([['tool_execution_failed', 'exec', 'tu2', 'errorType=ToolError', 'errorMsg=msg(boom)']]);
  });

  it('partialAssistantDiscarded → 展示载荷逐字段 + 审计行含 trace_id/contract_id 绑定', () => {
    const { audit, entries } = makeAudit();
    const onPartialAssistantDiscarded = vi.fn();
    const sink = createStepExecutorEventSink({ callbacks: { onPartialAssistantDiscarded } as StepCallbacks, auditWriter: audit as never, ...BINDING });

    sink.partialAssistantDiscarded({
      cause: 'all_providers_failed', toolUseCount: 2, hasText: true, hasThinking: false,
      tsRange: '100-200', errMessage: 'root-cause',
    });

    expect(onPartialAssistantDiscarded).toHaveBeenCalledWith({
      cause: 'all_providers_failed', toolUseCount: 2, hasText: true, hasThinking: false,
      startTs: 100, endTs: 200, errMessage: 'root-cause',
    });
    expect(entries).toEqual([[
      'partial_assistant_discarded',
      'cause=all_providers_failed', 'tool_use_count=2', 'has_text=true', 'has_thinking=false',
      'ts_range=100-200', 'trace_id=t-9', 'contract_id=c-1', 'err=msg(root-cause)',
    ]]);
  });

  it('partialAssistantDiscarded 审计写失败 → 不抛出（SE-D4 语义，stderr 留证）', () => {
    const failingAudit = {
      write: vi.fn(() => { throw new Error('audit down'); }),
      message: (s: string) => s,
      preview: (s: string) => s,
      summary: (s: string) => s,
    };
    const sink = createStepExecutorEventSink({ auditWriter: failingAudit as never, ...BINDING });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(() => sink.partialAssistantDiscarded({
      cause: 'unknown', toolUseCount: 0, hasText: false, hasThinking: false,
      tsRange: '1-2', errMessage: 'x',
    })).not.toThrow();
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    stderrSpy.mockRestore();
  });

  it('maxTokensStateAOrphanDrop → 展示一次（全量 orphans）+ 按 orphan 逐行持久化（preview 归 adapter）', () => {
    const { audit, entries } = makeAudit();
    const onMaxTokensStateAOrphanDrop = vi.fn();
    const llm = { model: 'm', inputTokens: 1, outputTokens: 1, latencyMs: 5 };
    const sink = createStepExecutorEventSink({ callbacks: { onMaxTokensStateAOrphanDrop } as StepCallbacks, auditWriter: audit as never, ...BINDING });

    sink.maxTokensStateAOrphanDrop({
      orphans: [
        { toolUseId: 'o1', isError: false, content: 'body-1' },
        { toolUseId: 'o2', isError: true, content: 'body-2' },
      ],
      llm,
    });

    expect(onMaxTokensStateAOrphanDrop).toHaveBeenCalledTimes(1);
    expect(onMaxTokensStateAOrphanDrop).toHaveBeenCalledWith({
      orphans: [
        { tool_use_id: 'o1', content: 'body-1', is_error: false },
        { tool_use_id: 'o2', content: 'body-2', is_error: true },
      ],
      llm,
    });
    expect(entries).toEqual([
      ['max_tokens_state_a_orphan_drop', 'tool_use_id=o1', 'is_error=false', 'content_preview=prev(body-1)', 'model=m'],
      ['max_tokens_state_a_orphan_drop', 'tool_use_id=o2', 'is_error=true', 'content_preview=prev(body-2)', 'model=m'],
    ]);
  });

  it('llmEmptyResponse / llmUnknownStopReason / unparseableToolUse → 展示 + 审计行', () => {
    const { audit, entries } = makeAudit();
    const cbs = {
      onEmptyResponse: vi.fn(),
      onUnknownStopReason: vi.fn(),
      onUnparseableToolUse: vi.fn(),
    };
    const sink = createStepExecutorEventSink({ callbacks: cbs as unknown as StepCallbacks, auditWriter: audit as never, ...BINDING });

    sink.llmEmptyResponse({ stopReason: 'stop' });
    sink.llmUnknownStopReason({ stopReason: 'refusal' });
    sink.unparseableToolUse({ stopReason: 'max_tokens' });

    expect(cbs.onEmptyResponse).toHaveBeenCalledWith('stop');
    expect(cbs.onUnknownStopReason).toHaveBeenCalledWith('refusal');
    expect(cbs.onUnparseableToolUse).toHaveBeenCalledWith('max_tokens');
    expect(entries).toEqual([
      ['llm_empty_response', 'stop_reason=stop'],
      ['llm_unknown_stop_reason', 'stop_reason=refusal'],
      ['llm_unparseable_tool_use', 'stop_reason=max_tokens'],
    ]);
  });

  it('maxTokensAssistantEmptySkipped / maxTokensPrebuiltOnlyFinal → 展示载荷全量 llmInfo + 审计行', () => {
    const { audit, entries } = makeAudit();
    const cbs = {
      onMaxTokensAssistantEmptySkipped: vi.fn(),
      onMaxTokensPrebuiltOnlyFinal: vi.fn(),
    };
    const llm = { model: 'm2', inputTokens: 3, outputTokens: 4, latencyMs: 7 };
    const sink = createStepExecutorEventSink({ callbacks: cbs as unknown as StepCallbacks, auditWriter: audit as never, ...BINDING });

    sink.maxTokensAssistantEmptySkipped({ llm });
    sink.maxTokensPrebuiltOnlyFinal({ prebuiltCount: 3, llm });

    expect(cbs.onMaxTokensAssistantEmptySkipped).toHaveBeenCalledWith({ llm });
    expect(cbs.onMaxTokensPrebuiltOnlyFinal).toHaveBeenCalledWith({ prebuiltCount: 3, llm });
    expect(entries).toEqual([
      ['max_tokens_assistant_empty_skipped', 'model=m2'],
      ['max_tokens_prebuilt_only_final', 'prebuilt_count=3', 'model=m2'],
    ]);
  });

  it('invariantViolation → 审计行（site/kind/reason/index/msg 列）', () => {
    const { audit, entries } = makeAudit();
    const sink = createStepExecutorEventSink({ auditWriter: audit as never, ...BINDING });

    sink.invariantViolation({ site: 's.ts:1', kind: 'k', reason: 'r', index: 2, msg: 'm' });

    expect(entries).toEqual([['step_executor_invariant_violation', 'site=s.ts:1', 'kind=k', 'reason=r', 'index=2', 'msg=m']]);
  });

  it('展示 callback throw（B 级）→ 不传播、onSafeCallbackError 留证', () => {
    const { audit, entries } = makeAudit();
    const onSafeCallbackError = vi.fn();
    const sink = createStepExecutorEventSink({
      callbacks: {
        onEmptyResponse: () => { throw new Error('display-boom'); },
        onSafeCallbackError,
      } as unknown as StepCallbacks,
      auditWriter: audit as never,
      ...BINDING,
    });

    expect(() => sink.llmEmptyResponse({ stopReason: 'stop' })).not.toThrow();
    expect(onSafeCallbackError).toHaveBeenCalledWith('onEmptyResponse', expect.any(Error));
    expect(entries.some(c => c[0] === 'step_executor_callback_failed')).toBe(true);
  });

  it('无 auditWriter（caller 未注入）→ 展示仍发生、持久化静默跳过', () => {
    const onEmptyResponse = vi.fn();
    const sink = createStepExecutorEventSink({ callbacks: { onEmptyResponse } as unknown as StepCallbacks });

    expect(() => sink.llmEmptyResponse({ stopReason: 'stop' })).not.toThrow();
    expect(onEmptyResponse).toHaveBeenCalledWith('stop');
  });
});
