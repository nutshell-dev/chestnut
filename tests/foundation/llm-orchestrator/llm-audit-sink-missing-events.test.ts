import { describe, it, expect } from 'vitest';
import { createLLMAuditSink } from '../../../src/assembly/llm-audit-sink.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';

describe('llm-audit-sink phase 952 r118 K fork: 2 missing LLMEvent case (phase 882 S3 continuation)', () => {
  it('emits context_exceeded_failover audit row', () => {
    const writes: any[][] = [];
    const audit: AuditLog = { write: (...args) => writes.push(args) } as any;
    const sink = createLLMAuditSink(audit);
    sink.emit({ type: 'context_exceeded_failover', provider: 'openai', stopReason: 'context_window_exceeded' });
    expect(writes.length).toBe(1);
    expect(writes[0][0]).toBe('llm_context_exceeded_failover');
    expect(writes[0]).toEqual(expect.arrayContaining(['provider=openai', 'stopReason=context_window_exceeded']));
  });

  it('emits permanent_skip_retry audit row', () => {
    const writes: any[][] = [];
    const audit: AuditLog = { write: (...args) => writes.push(args) } as any;
    const sink = createLLMAuditSink(audit);
    sink.emit({ type: 'permanent_skip_retry', provider: 'openai', attempt: 3, errorClass: 'permanent' });
    expect(writes.length).toBe(1);
    expect(writes[0][0]).toBe('llm_permanent_skip_retry');
    expect(writes[0]).toEqual(expect.arrayContaining(['provider=openai', 'attempt=3', 'errorClass=permanent']));
  });
});
