import { describe, it, expect, vi } from 'vitest';
import {
  emitSnapshotCommitted,
  emitSnapshotCommitFailed,
  emitSnapshotDegraded,
  emitSnapshotInitCleanupFailed,
  emitSnapshotInitFailed,
  emitSnapshotPersistFailed,
  emitSnapshotStatusStderr,
  emitSnapshotSyncCleanFailed,
  emitSnapshotSyncRestoreFailed,
} from '../../../src/foundation/snapshot/audit-emit.js';
import { SNAPSHOT_AUDIT_EVENTS } from '../../../src/foundation/snapshot/audit-events.js';

describe('snapshot typed audit emit (phase 1127)', () => {
  const makeMockAudit = () => ({
    write: vi.fn() as ReturnType<typeof vi.fn>,
  });

  // 主路径
  it('emitSnapshotCommitted serialize 到正确 cols', () => {
    const audit = makeMockAudit();
    emitSnapshotCommitted(audit, { dir: '/x', message: 'hello' });
    expect(audit.write).toHaveBeenCalledWith(SNAPSHOT_AUDIT_EVENTS.COMMITTED, 'dir=/x', 'message=hello');
  });

  it('emitSnapshotCommitFailed 含 optional fields serialize 顺序正确', () => {
    const audit = makeMockAudit();
    emitSnapshotCommitFailed(audit, { dir: '/x', kind: 'oom', consecutive: 3 });
    expect(audit.write).toHaveBeenCalledWith(SNAPSHOT_AUDIT_EVENTS.COMMIT_FAILED, 'dir=/x', 'kind=oom', 'consecutive=3');
  });

  it('emitSnapshotCommitFailed 含 context typed enum', () => {
    const audit = makeMockAudit();
    emitSnapshotCommitFailed(audit, { dir: '/x', context: 'state_restored_from_disk', consecutive: 1 });
    expect(audit.write).toHaveBeenCalledWith(
      SNAPSHOT_AUDIT_EVENTS.COMMIT_FAILED,
      'dir=/x',
      'context=state_restored_from_disk',
      'consecutive=1',
    );
  });

  it('emitSnapshotInitFailed 含 context', () => {
    const audit = makeMockAudit();
    emitSnapshotInitFailed(audit, { dir: '/x', context: 'incomplete_repo_reinit' });
    expect(audit.write).toHaveBeenCalledWith(
      SNAPSHOT_AUDIT_EVENTS.INIT_FAILED,
      'dir=/x',
      'context=incomplete_repo_reinit',
    );
  });

  it('emitSnapshotInitFailed 含 kind', () => {
    const audit = makeMockAudit();
    emitSnapshotInitFailed(audit, { dir: '/x', kind: 'corrupt' });
    expect(audit.write).toHaveBeenCalledWith(SNAPSHOT_AUDIT_EVENTS.INIT_FAILED, 'dir=/x', 'kind=corrupt');
  });

  it('emitSnapshotInitCleanupFailed serialize 正确', () => {
    const audit = makeMockAudit();
    emitSnapshotInitCleanupFailed(audit, { dir: '/x', reason: 'EPERM' });
    expect(audit.write).toHaveBeenCalledWith(
      SNAPSHOT_AUDIT_EVENTS.INIT_CLEANUP_FAILED,
      'dir=/x',
      'reason=EPERM',
    );
  });

  it('emitSnapshotStatusStderr serialize 正确', () => {
    const audit = makeMockAudit();
    emitSnapshotStatusStderr(audit, { dir: '/x', stderr: 'fatal: bad tree' });
    expect(audit.write).toHaveBeenCalledWith(
      SNAPSHOT_AUDIT_EVENTS.STATUS_STDERR,
      'dir=/x',
      'stderr=fatal: bad tree',
    );
  });

  it('emitSnapshotSyncCleanFailed 含 context + cleanupDir', () => {
    const audit = makeMockAudit();
    emitSnapshotSyncCleanFailed(audit, {
      dir: '/x',
      context: 'empty_or_escaping_relDir',
      cleanupDir: '/y',
    });
    expect(audit.write).toHaveBeenCalledWith(
      SNAPSHOT_AUDIT_EVENTS.SYNC_CLEAN_FAILED,
      'dir=/x',
      'context=empty_or_escaping_relDir',
      'cleanupDir=/y',
    );
  });

  it('emitSnapshotSyncCleanFailed 含 context + cleanupDir + resolved', () => {
    const audit = makeMockAudit();
    emitSnapshotSyncCleanFailed(audit, {
      dir: '/x',
      context: 'symlink_traversal',
      cleanupDir: '/y',
      resolved: '/z',
    });
    expect(audit.write).toHaveBeenCalledWith(
      SNAPSHOT_AUDIT_EVENTS.SYNC_CLEAN_FAILED,
      'dir=/x',
      'context=symlink_traversal',
      'cleanupDir=/y',
      'resolved=/z',
    );
  });

  it('emitSnapshotSyncCleanFailed 仅 reason', () => {
    const audit = makeMockAudit();
    emitSnapshotSyncCleanFailed(audit, { dir: '/x', reason: 'disk full' });
    expect(audit.write).toHaveBeenCalledWith(
      SNAPSHOT_AUDIT_EVENTS.SYNC_CLEAN_FAILED,
      'dir=/x',
      'reason=disk full',
    );
  });

  it('emitSnapshotSyncRestoreFailed serialize 正确', () => {
    const audit = makeMockAudit();
    emitSnapshotSyncRestoreFailed(audit, { dir: '/x', restoreReason: 'disk full' });
    expect(audit.write).toHaveBeenCalledWith(
      SNAPSHOT_AUDIT_EVENTS.SYNC_RESTORE_FAILED,
      'dir=/x',
      'restoreReason=disk full',
    );
  });

  it('emitSnapshotDegraded serialize 正确', () => {
    const audit = makeMockAudit();
    emitSnapshotDegraded(audit, { dir: '/x', consecutive: 3 });
    expect(audit.write).toHaveBeenCalledWith(
      SNAPSHOT_AUDIT_EVENTS.DEGRADED,
      'dir=/x',
      'consecutive=3',
    );
  });

  it('emitSnapshotPersistFailed serialize 正确', () => {
    const audit = makeMockAudit();
    emitSnapshotPersistFailed(audit, { dir: '/x', reason: 'writeAtomic failed' });
    expect(audit.write).toHaveBeenCalledWith(
      SNAPSHOT_AUDIT_EVENTS.PERSIST_FAILED,
      'dir=/x',
      'reason=writeAtomic failed',
    );
  });

  // 反向 1（误删反向）：emit fn 内部 audit.write 删 → test fail
  it('反向 1: emit fn 实然调 audit.write', () => {
    const audit = makeMockAudit();
    emitSnapshotInitFailed(audit, { dir: '/x', kind: 'corrupt' });
    expect(audit.write).toHaveBeenCalled();
  });

  // 反向 2（schema 反向）：payload key 错应 tsc fail
  it('反向 2: typed payload key TS enforce', () => {
    const audit = makeMockAudit();
    // @ts-expect-error: typo 'msg' (should be 'message')
    emitSnapshotCommitted(audit, { dir: '/x', msg: 'hello' });
    expect(audit.write).toHaveBeenCalledTimes(1);
  });

  // 反向 3（边界路径反向）：optional field undefined 时不输出 col
  it('反向 3: optional field undefined 时 cols 不含该 key', () => {
    const audit = makeMockAudit();
    emitSnapshotInitFailed(audit, { dir: '/x' }); // 无 kind + 无 context
    expect(audit.write).toHaveBeenCalledWith(SNAPSHOT_AUDIT_EVENTS.INIT_FAILED, 'dir=/x');
    // 确认 cols 数 = 1（仅 dir）
    expect((audit.write.mock.calls[0] as unknown as unknown[]).length).toBe(2); // event + dir col
  });
});
