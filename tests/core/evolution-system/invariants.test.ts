import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { assertRetrospectiveRowShape } from '../../../src/core/evolution-system/invariants.js';
import { RETRO_AUDIT_EVENTS } from '../../../src/core/evolution-system/retro-audit-events.js';

function createMockAudit() {
  return {
    write: vi.fn(),
    preview: vi.fn((s: string) => s),
    message: vi.fn((s: string) => s),
    summary: vi.fn((s: string) => s),
    __brand: 'AuditLog' as const,
  };
}

function validRow(): unknown {
  return {
    schema_version: 1,
    contract_id: 'c-test-1',
    task_id: 'task-test-1',
    target_claw: 'claw-a',
    created_at: '2026-07-28T00:00:00.000Z',
  };
}

describe('evolution-system retrospective row invariant (phase 1206 Step C)', () => {
  let mockAudit: ReturnType<typeof createMockAudit>;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockAudit = createMockAudit();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('row root check', () => {
    it('row=null emits kind=row_not_object', () => {
      assertRetrospectiveRowShape(null, mockAudit as any, 'test');
      expect(mockAudit.write).toHaveBeenCalledWith(
        RETRO_AUDIT_EVENTS.EVOLUTION_STATE_INVARIANT_VIOLATED,
        `source=test`,
        `kind=row_not_object`,
        `actual=object`,
      );
    });

    it('row=undefined emits kind=row_not_object', () => {
      assertRetrospectiveRowShape(undefined, mockAudit as any, 'test');
      expect(mockAudit.write).toHaveBeenCalledWith(
        RETRO_AUDIT_EVENTS.EVOLUTION_STATE_INVARIANT_VIOLATED,
        `source=test`,
        `kind=row_not_object`,
        `actual=undefined`,
      );
    });

    it('row=string emits kind=row_not_object', () => {
      assertRetrospectiveRowShape('bad', mockAudit as any, 'test');
      expect(mockAudit.write).toHaveBeenCalledWith(
        RETRO_AUDIT_EVENTS.EVOLUTION_STATE_INVARIANT_VIOLATED,
        `source=test`,
        `kind=row_not_object`,
        `actual=string`,
      );
    });
  });

  describe('valid row', () => {
    it('all required fields present emits nothing', () => {
      assertRetrospectiveRowShape(validRow(), mockAudit as any, 'test');
      const calls = mockAudit.write.mock.calls.filter(c => c[0] === RETRO_AUDIT_EVENTS.EVOLUTION_STATE_INVARIANT_VIOLATED);
      expect(calls).toHaveLength(0);
    });

    it('extra fields are ignored', () => {
      assertRetrospectiveRowShape({ ...validRow(), extra: 123 }, mockAudit as any, 'test');
      const calls = mockAudit.write.mock.calls.filter(c => c[0] === RETRO_AUDIT_EVENTS.EVOLUTION_STATE_INVARIANT_VIOLATED);
      expect(calls).toHaveLength(0);
    });
  });

  describe('missing fields', () => {
    it('missing contract_id emits kind=missing_required_fields', () => {
      const row = { ...validRow(), contract_id: undefined };
      delete (row as Record<string, unknown>).contract_id;
      assertRetrospectiveRowShape(row, mockAudit as any, 'test');
      expect(mockAudit.write).toHaveBeenCalledWith(
        RETRO_AUDIT_EVENTS.EVOLUTION_STATE_INVARIANT_VIOLATED,
        `source=test`,
        `kind=missing_required_fields`,
        `fields=contract_id`,
      );
    });

    it('missing multiple fields lists all of them', () => {
      assertRetrospectiveRowShape(
        { schema_version: 1 },
        mockAudit as any,
        'test',
      );
      expect(mockAudit.write).toHaveBeenCalledWith(
        RETRO_AUDIT_EVENTS.EVOLUTION_STATE_INVARIANT_VIOLATED,
        `source=test`,
        `kind=missing_required_fields`,
        `fields=contract_id,task_id,target_claw,created_at`,
      );
    });

    it('non-string required field is treated as missing', () => {
      assertRetrospectiveRowShape(
        { ...validRow(), target_claw: 123 },
        mockAudit as any,
        'test',
      );
      expect(mockAudit.write).toHaveBeenCalledWith(
        RETRO_AUDIT_EVENTS.EVOLUTION_STATE_INVARIANT_VIOLATED,
        `source=test`,
        `kind=missing_required_fields`,
        `fields=target_claw`,
      );
    });
  });

  describe('schema_version', () => {
    it('wrong schema_version emits kind=schema_version_mismatch', () => {
      assertRetrospectiveRowShape(
        { ...validRow(), schema_version: 2 },
        mockAudit as any,
        'test',
      );
      expect(mockAudit.write).toHaveBeenCalledWith(
        RETRO_AUDIT_EVENTS.EVOLUTION_STATE_INVARIANT_VIOLATED,
        `source=test`,
        `kind=schema_version_mismatch`,
        `actual=2`,
        `expected=1`,
      );
    });

    it('missing schema_version emits kind=schema_version_mismatch', () => {
      const row = { ...validRow() };
      delete (row as Record<string, unknown>).schema_version;
      assertRetrospectiveRowShape(row, mockAudit as any, 'test');
      expect(mockAudit.write).toHaveBeenCalledWith(
        RETRO_AUDIT_EVENTS.EVOLUTION_STATE_INVARIANT_VIOLATED,
        `source=test`,
        `kind=schema_version_mismatch`,
        `actual=undefined`,
        `expected=1`,
      );
    });
  });
});
