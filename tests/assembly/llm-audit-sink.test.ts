/**
 * LLM audit sink tests
 *
 * Tests: createLLMAuditSink — audit.write throw 时的 console.error fallback + isolation 保
 * 历史：phase604 NEW
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createLLMAuditSink } from '../../src/assembly/llm-audit-sink.js';
import type { AuditLog } from '../../src/foundation/audit/index.js';

describe('createLLMAuditSink critical fallback (phase 604 / B.llm-audit-sink-recursion-boundary)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('audit.write throw → console.error [LLM AUDIT SINK CRITICAL] + sink 不抛（isolation 保）', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const audit: AuditLog = {
      write: vi.fn(() => { throw new Error('audit fs full'); }),
    };
    const sink = createLLMAuditSink(audit);

    // sink emit 不抛（isolation 保）
    expect(() => sink.emit({
      type: 'provider_attempt_failed',
      provider: 'openai',
      attempt: 1,
      error: 'mock',
    } as any)).not.toThrow();

    // console.error 真触发 + 含 [LLM AUDIT SINK CRITICAL] prefix
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^\[LLM AUDIT SINK CRITICAL\]/),
    );

    consoleSpy.mockRestore();
  });

  it('audit.write success → console.error 0 调（无 fallback noise）', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const audit: AuditLog = {
      write: vi.fn(),   // 成功
    };
    const sink = createLLMAuditSink(audit);

    sink.emit({
      type: 'provider_attempt_failed',
      provider: 'openai',
      attempt: 1,
      error: 'mock',
    } as any);

    expect(consoleSpy).not.toHaveBeenCalled();
    expect(audit.write).toHaveBeenCalledTimes(1);

    consoleSpy.mockRestore();
  });
});
