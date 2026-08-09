import { describe, expect, it, vi } from 'vitest';
import { classifyAndAuditError } from '../../../src/core/subagent/error-classifier.js';
import { REACT_LOOP_AUDIT_EVENTS } from '../../../src/core/subagent/audit-events.js';
import { ExternalAbortError } from '../../../src/foundation/llm-provider/index.js';
import { STREAM_AGENT_EVENTS } from '../../../src/core/agent-executor/index.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';

describe('classifyAndAuditError', () => {
  it('classifies the typed external-abort protocol as an interruption', () => {
    const safeSwWrite = vi.fn();
    const auditWriter = { write: vi.fn() } as unknown as AuditLog;

    classifyAndAuditError({
      error: new ExternalAbortError({ type: 'external' }),
      safeSwWrite,
      auditWriter,
      timeoutMs: 1_000,
    });

    expect(safeSwWrite).toHaveBeenCalledWith(expect.objectContaining({
      type: STREAM_AGENT_EVENTS.TURN_INTERRUPTED,
      cause: 'external',
    }));
    expect(auditWriter.write).toHaveBeenCalledWith(
      REACT_LOOP_AUDIT_EVENTS.TURN_INTERRUPTED,
      'cause=external',
      'type=external',
    );
  });

  it('does not classify an arbitrary name-only AbortError as the domain protocol', () => {
    const safeSwWrite = vi.fn();
    const auditWriter = { write: vi.fn() } as unknown as AuditLog;
    const nameOnlyError = new Error('untyped abort');
    nameOnlyError.name = 'AbortError';

    classifyAndAuditError({
      error: nameOnlyError,
      safeSwWrite,
      auditWriter,
      timeoutMs: 1_000,
    });

    expect(safeSwWrite).toHaveBeenCalledWith(expect.objectContaining({
      type: STREAM_AGENT_EVENTS.TURN_ERROR,
    }));
    expect(auditWriter.write).toHaveBeenCalledWith(
      REACT_LOOP_AUDIT_EVENTS.TURN_ERROR,
      expect.stringContaining('untyped abort'),
    );
  });
});
