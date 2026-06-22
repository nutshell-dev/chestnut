import { describe, it, expect } from 'vitest';
import { assertSnapshotStateShape } from '../../../src/foundation/snapshot/invariants.js';
import { SNAPSHOT_AUDIT_EVENTS } from '../../../src/foundation/snapshot/audit-events.js';
import { makeMockAudit } from '../../helpers/audit.js';

// phase 701: src 加 dir param、test 17 caller 加 TEST_DIR arg、14 assertion 加 dir col
const TEST_DIR = 'test-snapshot-dir';

describe('snapshot state shape invariant (phase 275 Step A + phase 285 Step A)', () => {
  describe('state 根 check', () => {
    it('state=null → emit kind=state_not_object', () => {
      const audit = makeMockAudit();
      assertSnapshotStateShape(null, audit, TEST_DIR);
      expect(audit.write).toHaveBeenCalledWith(
        SNAPSHOT_AUDIT_EVENTS.STATE_INVARIANT_VIOLATED,
        `dir=${TEST_DIR}`,
        'kind=state_not_object',
        'actual=object',
      );
    });

    it('state=42 → emit kind=state_not_object', () => {
      const audit = makeMockAudit();
      assertSnapshotStateShape(42, audit, TEST_DIR);
      expect(audit.write).toHaveBeenCalledWith(
        SNAPSHOT_AUDIT_EVENTS.STATE_INVARIANT_VIOLATED,
        `dir=${TEST_DIR}`,
        'kind=state_not_object',
        'actual=number',
      );
    });

    it('state=字符串 → emit kind=state_not_object', () => {
      const audit = makeMockAudit();
      assertSnapshotStateShape('bad', audit, TEST_DIR);
      expect(audit.write).toHaveBeenCalledWith(
        SNAPSHOT_AUDIT_EVENTS.STATE_INVARIANT_VIOLATED,
        `dir=${TEST_DIR}`,
        'kind=state_not_object',
        'actual=string',
      );
    });

    it('state={kind: 1} → emit kind=kind_invalid', () => {
      const audit = makeMockAudit();
      assertSnapshotStateShape({ kind: 1 }, audit, TEST_DIR);
      expect(audit.write).toHaveBeenCalledWith(
        SNAPSHOT_AUDIT_EVENTS.STATE_INVARIANT_VIOLATED,
        `dir=${TEST_DIR}`,
        'kind=kind_invalid',
        'actual=1',
      );
    });
  });

  describe('ok branch', () => {
    it('{ kind: "ok" } → 0 emit', () => {
      const audit = makeMockAudit();
      assertSnapshotStateShape({ kind: 'ok' }, audit, TEST_DIR);
      expect(audit.write).not.toHaveBeenCalled();
    });
  });

  describe('degraded branch', () => {
    it('合法 degraded → 0 emit', () => {
      const audit = makeMockAudit();
      assertSnapshotStateShape({ kind: 'degraded', failures: 3, degradedAt: 12345 }, audit, TEST_DIR);
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('failures=0 → 0 emit（边界合法）', () => {
      const audit = makeMockAudit();
      assertSnapshotStateShape({ kind: 'degraded', failures: 0, degradedAt: 12345 }, audit, TEST_DIR);
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('failures 缺省 → emit kind=failures_invalid', () => {
      const audit = makeMockAudit();
      assertSnapshotStateShape({ kind: 'degraded', degradedAt: 12345 }, audit, TEST_DIR);
      expect(audit.write).toHaveBeenCalledWith(
        SNAPSHOT_AUDIT_EVENTS.STATE_INVARIANT_VIOLATED,
        `dir=${TEST_DIR}`,
        'kind=failures_invalid',
        'actual=undefined',
      );
    });

    it('failures=NaN → emit kind=failures_invalid', () => {
      const audit = makeMockAudit();
      assertSnapshotStateShape({ kind: 'degraded', failures: NaN, degradedAt: 12345 }, audit, TEST_DIR);
      expect(audit.write).toHaveBeenCalledWith(
        SNAPSHOT_AUDIT_EVENTS.STATE_INVARIANT_VIOLATED,
        `dir=${TEST_DIR}`,
        'kind=failures_invalid',
        'actual=NaN',
      );
    });

    it('failures=Infinity → emit', () => {
      const audit = makeMockAudit();
      assertSnapshotStateShape({ kind: 'degraded', failures: Infinity, degradedAt: 12345 }, audit, TEST_DIR);
      expect(audit.write).toHaveBeenCalledWith(
        SNAPSHOT_AUDIT_EVENTS.STATE_INVARIANT_VIOLATED,
        `dir=${TEST_DIR}`,
        'kind=failures_invalid',
        'actual=Infinity',
      );
    });

    it('failures=-Infinity → emit', () => {
      const audit = makeMockAudit();
      assertSnapshotStateShape({ kind: 'degraded', failures: -Infinity, degradedAt: 12345 }, audit, TEST_DIR);
      expect(audit.write).toHaveBeenCalledWith(
        SNAPSHOT_AUDIT_EVENTS.STATE_INVARIANT_VIOLATED,
        `dir=${TEST_DIR}`,
        'kind=failures_invalid',
        'actual=-Infinity',
      );
    });

    it('failures=-1 → emit', () => {
      const audit = makeMockAudit();
      assertSnapshotStateShape({ kind: 'degraded', failures: -1, degradedAt: 12345 }, audit, TEST_DIR);
      expect(audit.write).toHaveBeenCalledWith(
        SNAPSHOT_AUDIT_EVENTS.STATE_INVARIANT_VIOLATED,
        `dir=${TEST_DIR}`,
        'kind=failures_invalid',
        'actual=-1',
      );
    });

    it('failures=1.5 → emit', () => {
      const audit = makeMockAudit();
      assertSnapshotStateShape({ kind: 'degraded', failures: 1.5, degradedAt: 12345 }, audit, TEST_DIR);
      expect(audit.write).toHaveBeenCalledWith(
        SNAPSHOT_AUDIT_EVENTS.STATE_INVARIANT_VIOLATED,
        `dir=${TEST_DIR}`,
        'kind=failures_invalid',
        'actual=1.5',
      );
    });

    it('failures=字符串 → emit', () => {
      const audit = makeMockAudit();
      assertSnapshotStateShape({ kind: 'degraded', failures: '3', degradedAt: 12345 }, audit, TEST_DIR);
      expect(audit.write).toHaveBeenCalledWith(
        SNAPSHOT_AUDIT_EVENTS.STATE_INVARIANT_VIOLATED,
        `dir=${TEST_DIR}`,
        'kind=failures_invalid',
        'actual=3',
      );
    });

    it('degradedAt 缺省 → emit kind=degradedAt_invalid', () => {
      const audit = makeMockAudit();
      assertSnapshotStateShape({ kind: 'degraded', failures: 1 }, audit, TEST_DIR);
      expect(audit.write).toHaveBeenCalledWith(
        SNAPSHOT_AUDIT_EVENTS.STATE_INVARIANT_VIOLATED,
        `dir=${TEST_DIR}`,
        'kind=degradedAt_invalid',
        'actual=undefined',
      );
    });

    it('degradedAt=NaN → emit kind=degradedAt_invalid', () => {
      const audit = makeMockAudit();
      assertSnapshotStateShape({ kind: 'degraded', failures: 1, degradedAt: NaN }, audit, TEST_DIR);
      expect(audit.write).toHaveBeenCalledWith(
        SNAPSHOT_AUDIT_EVENTS.STATE_INVARIANT_VIOLATED,
        `dir=${TEST_DIR}`,
        'kind=degradedAt_invalid',
        'actual=NaN',
      );
    });

    it('degradedAt=Infinity → emit', () => {
      const audit = makeMockAudit();
      assertSnapshotStateShape({ kind: 'degraded', failures: 1, degradedAt: Infinity }, audit, TEST_DIR);
      expect(audit.write).toHaveBeenCalledWith(
        SNAPSHOT_AUDIT_EVENTS.STATE_INVARIANT_VIOLATED,
        `dir=${TEST_DIR}`,
        'kind=degradedAt_invalid',
        'actual=Infinity',
      );
    });

    it('degradedAt=字符串 → emit', () => {
      const audit = makeMockAudit();
      assertSnapshotStateShape({ kind: 'degraded', failures: 1, degradedAt: 'now' }, audit, TEST_DIR);
      expect(audit.write).toHaveBeenCalledWith(
        SNAPSHOT_AUDIT_EVENTS.STATE_INVARIANT_VIOLATED,
        `dir=${TEST_DIR}`,
        'kind=degradedAt_invalid',
        'actual=now',
      );
    });
  });

  describe('多违例独立 emit', () => {
    it('failures + degradedAt 均非法 → 2 emit', () => {
      const audit = makeMockAudit();
      assertSnapshotStateShape({ kind: 'degraded', failures: 'bad', degradedAt: 'worse' }, audit, TEST_DIR);
      expect(audit.write).toHaveBeenCalledTimes(2);
      expect(audit.write).toHaveBeenNthCalledWith(
        1,
        SNAPSHOT_AUDIT_EVENTS.STATE_INVARIANT_VIOLATED,
        `dir=${TEST_DIR}`,
        'kind=failures_invalid',
        'actual=bad',
      );
      expect(audit.write).toHaveBeenNthCalledWith(
        2,
        SNAPSHOT_AUDIT_EVENTS.STATE_INVARIANT_VIOLATED,
        `dir=${TEST_DIR}`,
        'kind=degradedAt_invalid',
        'actual=worse',
      );
    });
  });
});
