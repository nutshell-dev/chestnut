/**
 * @module L4.Runtime.AgentExecutorAuditSink
 * @layer L4 运行时层
 * @depends L2.AuditLog, L3.AgentExecutor（事件 sink 协议 + 审计事件常量）
 * @consumers L4.Runtime
 *
 * phase 1856 (AE-D9): AgentExecutorEventSink → AuditLog 行的 caller adapter。
 * AgentExecutor 循环只发结构化事实；contract_id/trace_id 身份绑定与审计列
 * 格式化在本 adapter 完成（审计行内容与原循环内直写逐列保持一致）。
 */

import type { AuditLog } from '../../foundation/audit/index.js';
import type { ExecContext } from '../../foundation/tools/index.js';
import { AGENT_EXECUTOR_AUDIT_EVENTS, type AgentExecutorEventSink } from '../agent-executor/index.js';

export function createAgentExecutorAuditSink(deps: {
  auditWriter: AuditLog;
  currentContractId: string;
  execContext: ExecContext;
}): AgentExecutorEventSink {
  const { auditWriter, currentContractId, execContext } = deps;
  return {
    toolCallInput: (e) => {
      auditWriter.write(
        AGENT_EXECUTOR_AUDIT_EVENTS.TOOL_CALL_INPUT,
        e.toolName,
        `tool_use_id=${String(e.toolUseId)}`,
        `step=${e.step}`,
        `contract_id=${currentContractId ?? ''}`,
        `trace_id=${String(execContext.trace_id ?? '')}`,
        `args_size=${e.argsSize}`,
      );
    },
    toolResult: (e) => {
      const content = e.content ?? '';
      auditWriter.write(
        AGENT_EXECUTOR_AUDIT_EVENTS.TOOL_RESULT,
        e.toolName,
        `tool_use_id=${String(e.toolUseId)}`,
        `step=${e.step}`,
        `contract_id=${currentContractId ?? ''}`,
        `trace_id=${String(execContext.trace_id ?? '')}`,
        `status=${e.success ? 'ok' : 'err'}`,
        `content_size=${Buffer.byteLength(content, 'utf-8')}`,
        `summary=${auditWriter.summary(content)}`,
      );
    },
    stepCompleted: (e) => {
      auditWriter.write(
        AGENT_EXECUTOR_AUDIT_EVENTS.STEP_COMPLETED,
        `step=${e.step}`,
        `contract_id=${currentContractId ?? ''}`,
        `trace_id=${String(execContext.trace_id ?? '')}`,
      );
    },
  };
}
