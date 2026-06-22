import { describe, it, expect } from 'vitest';
import { auditSnapshotStateCrossSource } from '../../../src/foundation/snapshot/state-cross-source-audit.js';
import { SNAPSHOT_AUDIT_EVENTS } from '../../../src/foundation/snapshot/audit-events.js';
import { makeMockAudit } from '../../helpers/audit.js';

// phase 700: src 加 dir param、test 8 caller 加 dir arg、3 emit assertion 加 dir col
const TEST_DIR = 'test-snapshot-dir';

describe('snapshot state-internal cross-source audit (phase 275 Step B + phase 285 Step A)', () => {
  describe('ok branch', () => {
    it('{ kind: "ok" } → 0 emit', () => {
      const audit = makeMockAudit();
      auditSnapshotStateCrossSource({ kind: 'ok' }, audit, 1000, TEST_DIR);
      expect(audit.write).not.toHaveBeenCalled();
    });
  });

  describe('SC-1: degraded 时 failures >= 0 整数', () => {
    it('failures=0 → 0 emit', () => {
      const audit = makeMockAudit();
      auditSnapshotStateCrossSource({ kind: 'degraded', failures: 0, degradedAt: 500 }, audit, 1000, TEST_DIR);
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('failures=3 → 0 emit', () => {
      const audit = makeMockAudit();
      auditSnapshotStateCrossSource({ kind: 'degraded', failures: 3, degradedAt: 500 }, audit, 1000, TEST_DIR);
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('failures=-1 → emit sc1', () => {
      const audit = makeMockAudit();
      auditSnapshotStateCrossSource({ kind: 'degraded', failures: -1, degradedAt: 500 }, audit, 1000, TEST_DIR);
      expect(audit.write).toHaveBeenCalledWith(
        SNAPSHOT_AUDIT_EVENTS.STATE_CROSS_SOURCE_MISMATCH,
        `dir=${TEST_DIR}`,
        'kind=sc1_failures_invalid',
        'actual=-1',
      );
    });

    it('failures=1.5 → emit sc1', () => {
      const audit = makeMockAudit();
      auditSnapshotStateCrossSource({ kind: 'degraded', failures: 1.5, degradedAt: 500 }, audit, 1000, TEST_DIR);
      expect(audit.write).toHaveBeenCalledWith(
        SNAPSHOT_AUDIT_EVENTS.STATE_CROSS_SOURCE_MISMATCH,
        `dir=${TEST_DIR}`,
        'kind=sc1_failures_invalid',
        'actual=1.5',
      );
    });
  });

  describe('SC-3: degraded 时 degradedAt <= now', () => {
    it('degradedAt < now → 0 emit', () => {
      const audit = makeMockAudit();
      auditSnapshotStateCrossSource({ kind: 'degraded', failures: 3, degradedAt: 500 }, audit, 1000, TEST_DIR);
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('degradedAt == now → 0 emit', () => {
      const audit = makeMockAudit();
      auditSnapshotStateCrossSource({ kind: 'degraded', failures: 3, degradedAt: 1000 }, audit, 1000, TEST_DIR);
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('degradedAt > now → emit sc3', () => {
      const audit = makeMockAudit();
      auditSnapshotStateCrossSource({ kind: 'degraded', failures: 3, degradedAt: 1500 }, audit, 1000, TEST_DIR);
      expect(audit.write).toHaveBeenCalledWith(
        SNAPSHOT_AUDIT_EVENTS.STATE_CROSS_SOURCE_MISMATCH,
        `dir=${TEST_DIR}`,
        'kind=sc3_degradedAt_in_future',
        'degradedAt=1500',
        'now=1000',
      );
    });
  });

  describe('2 check 同时 trip', () => {
    it('SC-1 + SC-3 全违例 → 2 emit', () => {
      const audit = makeMockAudit();
      auditSnapshotStateCrossSource(
        { kind: 'degraded', failures: -1.5, degradedAt: 9999 },
        audit,
        1000,
        TEST_DIR,
      );
      expect(audit.write).toHaveBeenCalledTimes(2);
    });
  });
});
