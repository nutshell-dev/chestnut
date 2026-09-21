import { describe, it, expect } from 'vitest';
import { noopAuditLog } from '../../../src/foundation/audit/index.js';

describe('noopAuditLog（phase 1893 fallback 静默 audit）', () => {
  it('完整接口面全 noop（write 丢弃、clip 返回空串、artifact/loss 返回空数组）', () => {
    expect(noopAuditLog.__brand).toBe('AuditLog');
    expect(() => noopAuditLog.write('type', 'col')).not.toThrow();
    expect(noopAuditLog.preview('x'.repeat(500))).toBe('');
    expect(noopAuditLog.message('x'.repeat(500))).toBe('');
    expect(noopAuditLog.summary('x'.repeat(500))).toBe('');
    expect(
      noopAuditLog.artifact({
        owner: 'o',
        ref: 'r',
        sha256: 's',
        bytes: 1,
        schemaVersion: 1,
        partial: false,
      }),
    ).toEqual([]);
    expect(
      noopAuditLog.loss({
        source: 's',
        amount: 1,
        unit: 'bytes',
        reason: 'r',
        policyVersion: 1,
        recoverable: false,
      }),
    ).toEqual([]);
  });
});
