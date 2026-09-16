/**
 * Phase 1803 Step B (CT-D3): failure reporter typed ReportOutcome 边界专测。
 * Phase 1840: owner 失败协议与提醒链解耦——EventLoop 恢复链的失败端口/结构镜像
 * 已退役（提醒耗尽不再是契约失败来源），本文件只锁 ContractSystem owner 侧
 * 三态协议，并以源码负向断言锁定退役边界。
 *
 * 锁定：`ExecutionFailureSink.report` 返回 exhaustive 三态联合
 * （committed | retryable{error} | rejected{reason}），而非 Promise<void>
 * 以 resolve/reject 隐式承载 ack/retry 语义；caller 侧穷尽处理以 never
 * 检查保证（新增 kind 时 tsc 报错）。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type {
  ExecutionFailureReportOutcome,
  ExecutionFailureSink,
} from '../../../src/core/contract/index.js';

/** caller 侧穷尽 reducer：新增 kind 时 never 检查编译失败。 */
function reduceOutcome(outcome: ExecutionFailureReportOutcome): string {
  switch (outcome.kind) {
    case 'committed':
      return 'close-evidence';
    case 'retryable':
      return `retry:${outcome.error}`;
    case 'rejected':
      return `retain:${outcome.reason}`;
    default: {
      const exhaustive: never = outcome;
      throw new Error(`unhandled outcome kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

const recoverySource = readFileSync(
  new URL('../../../src/core/event-loop/execution-recovery.ts', import.meta.url),
  'utf8',
);
const eventLoopTypesSource = readFileSync(
  new URL('../../../src/core/event-loop/types.ts', import.meta.url),
  'utf8',
);
const runtimeAssemblySource = readFileSync(
  new URL('../../../src/assembly/runtime-assembly.ts', import.meta.url),
  'utf8',
);
const eventLoopBarrelSource = readFileSync(
  new URL('../../../src/core/event-loop/index.ts', import.meta.url),
  'utf8',
);

describe('phase 1803/1840: owner 失败协议与提醒链解耦（CT-D3）', () => {
  it('sink.report 返回 Promise<ExecutionFailureReportOutcome>，不再是 Promise<void>', () => {
    // 类型级锚定：report 签名必须承载三态联合。
    const sink: ExecutionFailureSink = {
      report: async () => ({ kind: 'committed' }),
    };
    const result: ReturnType<ExecutionFailureSink['report']> = sink.report({
      executorId: 'e',
      producer: 'p',
      reason: 'r',
      evidenceRef: 'ref',
    });
    expect(result).toBeInstanceOf(Promise);
  });

  it('三态联合穷尽处理：committed 闭合 / retryable 携带 error / rejected 携带 reason', () => {
    expect(reduceOutcome({ kind: 'committed' })).toBe('close-evidence');
    expect(reduceOutcome({ kind: 'retryable', error: 'fs busy' })).toBe('retry:fs busy');
    expect(reduceOutcome({ kind: 'rejected', reason: 'executor mismatch' })).toBe('retain:executor mismatch');
  });

  it('证据字段不丢：retryable.error / rejected.reason 为必填 string', () => {
    const retryable: ExecutionFailureReportOutcome = { kind: 'retryable', error: 'cause' };
    const rejected: ExecutionFailureReportOutcome = { kind: 'rejected', reason: 'why' };
    // 类型上 error/reason 非 optional——若退化为可选，下面访问会是 string | undefined。
    const error: string = retryable.kind === 'retryable' ? retryable.error : '';
    const reason: string = rejected.kind === 'rejected' ? rejected.reason : '';
    expect(error).toBe('cause');
    expect(reason).toBe('why');
  });

  it('Phase 1840: 恢复链/装配无 failureSink 属性，controller 无失败报告调用', () => {
    // 提醒链失败端口退役的源码级负向断言（不断言 ContractSystem 全局
    // failActiveForExecutor 零命中——其他真实失败源保留）。
    for (const [name, source] of [
      ['execution-recovery.ts', recoverySource],
      ['event-loop types.ts', eventLoopTypesSource],
      ['runtime-assembly.ts', runtimeAssemblySource],
    ] as const) {
      expect(source, name).not.toMatch(/\bfailureSink\s*:/);
    }
    expect(recoverySource).not.toContain('failureSink.report');
  });

  it('Phase 1840: EventLoop barrel 不再导出恢复链失败类型', () => {
    expect(eventLoopBarrelSource).not.toMatch(/ExecutionRecoveryFailureSink/);
    expect(eventLoopBarrelSource).not.toMatch(/ExecutionRecoveryReportOutcome/);
    expect(eventLoopBarrelSource).not.toMatch(/MAX_EXECUTION_RECOVERY_ATTEMPTS/);
  });
});
