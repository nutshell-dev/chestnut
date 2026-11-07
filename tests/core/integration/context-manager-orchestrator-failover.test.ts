import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * L2 只消费 typed context 协议，不识别 L4 的错误名称。
 * L4 ContextTrimExhaustedError 自身仍归 ContextManager 所有，本测试不构造或驱动它。
 */
describe('orchestrator upper-layer context error boundary', () => {
  it('does not contain the L4 ContextTrim error name or its dedicated failover', () => {
    const source = readFileSync(
      new URL('../../../src/foundation/llm-orchestrator/invocation-executor.ts', import.meta.url),
      'utf8',
    );

    expect(source).not.toContain('ContextTrimExhaustedError');
    expect(source).not.toContain('CONTEXT_TRIM_EXHAUSTED_ERROR_NAME');
    expect(source).not.toContain("stopReason: 'context_trim_exhausted'");
  });
});
