/**
 * Phase 1803 Step B (CT-D3): failure reporter typed ReportOutcome 边界专测。
 *
 * 锁定：`ExecutionFailureSink.report` 返回 exhaustive 三态联合
 * （committed | retryable{error} | rejected{reason}），而非 Promise<void>
 * 以 resolve/reject 隐式承载 ack/retry 语义；event-loop consumer-owned
 * 结构镜像与 contract owner 联合双向可赋值（结构等价）；caller 侧穷尽
 * 处理以 never 检查保证（新增 kind 时 tsc 报错）。
 */
import { describe, expect, it } from 'vitest';
import type {
  ExecutionFailureReportOutcome,
  ExecutionFailureSink,
} from '../../../src/core/contract/index.js';
import type { ExecutionRecoveryReportOutcome } from '../../../src/core/event-loop/index.js';

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

describe('phase 1803: failure reporter typed ReportOutcome（CT-D3）', () => {
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

  it('event-loop consumer 结构镜像与 contract owner 联合双向可赋值', () => {
    // 结构等价：两个方向都可赋值（event-loop 不 import contract 类型，靠结构镜像）。
    const ownerOutcome: ExecutionFailureReportOutcome = { kind: 'retryable', error: 'x' };
    const consumerOutcome: ExecutionRecoveryReportOutcome = ownerOutcome;
    const backToOwner: ExecutionFailureReportOutcome = consumerOutcome;
    expect(backToOwner).toEqual({ kind: 'retryable', error: 'x' });
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
});
