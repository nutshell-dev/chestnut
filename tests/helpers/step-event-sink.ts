/**
 * phase 1857 Step I (SE-D9) 测试 helper：经真实 caller adapter 构造 StepExecutorEventSink。
 * 展示（callbacks）+ 持久化（audit 行）组合与生产路径同源，等价矩阵断言更可信。
 */

import { createStepExecutorEventSink } from '../../src/core/step-executor/index.js';
import type { StepCallbacks } from '../../src/core/step-executor/index.js';

export function makeAuditCollector() {
  const entries: unknown[][] = [];
  const audit = {
    write: (...cols: unknown[]) => { entries.push(cols); },
    message: (s: string) => s,
    preview: (s: string) => s,
    summary: (s: string) => s,
  };
  return { audit, entries };
}

export function makeStepEventSink(deps: {
  callbacks?: StepCallbacks;
  audit?: unknown;
  contractId?: string;
  traceId?: string;
} = {}) {
  return createStepExecutorEventSink({
    callbacks: deps.callbacks,
    auditWriter: deps.audit as never,
    contractId: deps.contractId,
    traceId: deps.traceId,
  });
}
