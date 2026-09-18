/**
 * phase 1856 AE-D9: runtime caller adapter（createAgentExecutorAuditSink）测试。
 *
 * 锁审计行与原 agent-executor 循环内直写逐列一致（含空 contract/trace fallback）：
 * - agent_tool_call_input: toolName, tool_use_id=, step=, contract_id=, trace_id=, args_size=
 * - agent_tool_result:     + status=, content_size=, summary=
 * - agent_step_completed:  step=, contract_id=, trace_id=
 */

import { describe, it, expect, vi } from 'vitest';
import { createAgentExecutorAuditSink } from '../../../src/core/runtime/agent-executor-audit-sink.js';
import { AGENT_EXECUTOR_AUDIT_EVENTS } from '../../../src/core/agent-executor/index.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import { makeExecContext } from '../../helpers/exec-context.js';

function makeAuditWriter(): AuditLog & { write: ReturnType<typeof vi.fn> } {
  return {
    write: vi.fn(),
    summary: vi.fn((s: string) => (s.length > 8 ? s.slice(0, 8) : s)),
    preview: vi.fn((s: string) => s),
    message: vi.fn((s: string) => s),
  } as unknown as AuditLog & { write: ReturnType<typeof vi.fn> };
}

describe('createAgentExecutorAuditSink（phase 1856 AE-D9）', () => {
  it('toolCallInput → 审计行逐列一致（身份绑定在 adapter）', () => {
    const auditWriter = makeAuditWriter();
    const ctx = { ...makeExecContext(), trace_id: 'trace-1' };
    const sink = createAgentExecutorAuditSink({ auditWriter, currentContractId: 'c-9', execContext: ctx });

    sink.toolCallInput({ toolName: 'read', toolUseId: 'tu-1' as never, step: 3, argsSize: 42 });

    expect(auditWriter.write).toHaveBeenCalledWith(
      AGENT_EXECUTOR_AUDIT_EVENTS.TOOL_CALL_INPUT,
      'read',
      'tool_use_id=tu-1',
      'step=3',
      'contract_id=c-9',
      'trace_id=trace-1',
      'args_size=42',
    );
  });

  it('toolResult → 审计行逐列一致（status/content_size/summary 语义保持）', () => {
    const auditWriter = makeAuditWriter();
    const ctx = { ...makeExecContext(), trace_id: 'trace-2' };
    const sink = createAgentExecutorAuditSink({ auditWriter, currentContractId: '', execContext: ctx });

    sink.toolResult({ toolName: 'write', toolUseId: 'tu-2' as never, step: 1, success: false, content: 'some error content' });

    expect(auditWriter.write).toHaveBeenCalledWith(
      AGENT_EXECUTOR_AUDIT_EVENTS.TOOL_RESULT,
      'write',
      'tool_use_id=tu-2',
      'step=1',
      'contract_id=',
      'trace_id=trace-2',
      'status=err',
      `content_size=${Buffer.byteLength('some error content', 'utf-8')}`,
      'summary=some err',
    );
  });

  it('stepCompleted → 审计行逐列一致（空 trace fallback）', () => {
    const auditWriter = makeAuditWriter();
    const ctx = { ...makeExecContext(), trace_id: undefined };
    const sink = createAgentExecutorAuditSink({ auditWriter, currentContractId: 'c-1', execContext: ctx });

    sink.stepCompleted({ step: 7 });

    expect(auditWriter.write).toHaveBeenCalledWith(
      AGENT_EXECUTOR_AUDIT_EVENTS.STEP_COMPLETED,
      'step=7',
      'contract_id=c-1',
      'trace_id=',
    );
  });
});
