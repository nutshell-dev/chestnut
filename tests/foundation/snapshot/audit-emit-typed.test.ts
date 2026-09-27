import { describe, it, expect } from 'vitest';
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
  emitSnapshotVersionInitFailed,
  emitSnapshotVersionExported,
  emitSnapshotVersionExportFailed,
  emitSnapshotVersionPublishBusy,
  emitSnapshotVersionPublishConflict,
  emitSnapshotVersionPublished,
  emitSnapshotVersionPublishFailed,
  emitSnapshotVersionSaved,
  emitSnapshotVersionSaveFailed,
  emitSnapshotVersionWorkspaceBegan,
} from '../../../src/foundation/snapshot/audit-emit.js';
import { SNAPSHOT_AUDIT_EVENTS } from '../../../src/foundation/snapshot/audit-events.js';
import { makeMockAudit } from '../../helpers/audit.js';

describe('snapshot typed audit emit (phase 1127)', () => {
  const makeMockAuditLocal = makeMockAudit;

  // 主路径
  it('emitSnapshotCommitted serialize 到正确 cols', () => {
    const audit = makeMockAuditLocal();
    emitSnapshotCommitted(audit, { dir: '/x', message: 'hello' });
    expect(audit.write).toHaveBeenCalledWith(SNAPSHOT_AUDIT_EVENTS.COMMITTED, 'dir=/x', 'message=hello');
  });

  it('emitSnapshotCommitFailed 含 optional fields serialize 顺序正确', () => {
    const audit = makeMockAuditLocal();
    emitSnapshotCommitFailed(audit, { dir: '/x', kind: 'oom', consecutive: 3 });
    expect(audit.write).toHaveBeenCalledWith(SNAPSHOT_AUDIT_EVENTS.COMMIT_FAILED, 'dir=/x', 'kind=oom', 'consecutive=3');
  });

  it('emitSnapshotCommitFailed 含 context typed enum', () => {
    const audit = makeMockAuditLocal();
    emitSnapshotCommitFailed(audit, { dir: '/x', context: 'state_restored_from_disk', consecutive: 1 });
    expect(audit.write).toHaveBeenCalledWith(
      SNAPSHOT_AUDIT_EVENTS.COMMIT_FAILED,
      'dir=/x',
      'context=state_restored_from_disk',
      'consecutive=1',
    );
  });

  it('emitSnapshotInitFailed 含 context', () => {
    const audit = makeMockAuditLocal();
    emitSnapshotInitFailed(audit, { dir: '/x', context: 'incomplete_repo_reinit' });
    expect(audit.write).toHaveBeenCalledWith(
      SNAPSHOT_AUDIT_EVENTS.INIT_FAILED,
      'dir=/x',
      'context=incomplete_repo_reinit',
    );
  });

  it('emitSnapshotInitFailed 含 kind', () => {
    const audit = makeMockAuditLocal();
    emitSnapshotInitFailed(audit, { dir: '/x', kind: 'corrupt' });
    expect(audit.write).toHaveBeenCalledWith(SNAPSHOT_AUDIT_EVENTS.INIT_FAILED, 'dir=/x', 'kind=corrupt');
  });

  it('emitSnapshotInitCleanupFailed serialize 正确', () => {
    const audit = makeMockAuditLocal();
    emitSnapshotInitCleanupFailed(audit, { dir: '/x', reason: 'EPERM' });
    expect(audit.write).toHaveBeenCalledWith(
      SNAPSHOT_AUDIT_EVENTS.INIT_CLEANUP_FAILED,
      'dir=/x',
      'reason=EPERM',
    );
  });

  it('emitSnapshotStatusStderr serialize 正确', () => {
    const audit = makeMockAuditLocal();
    emitSnapshotStatusStderr(audit, { dir: '/x', stderr: 'fatal: bad tree' });
    expect(audit.write).toHaveBeenCalledWith(
      SNAPSHOT_AUDIT_EVENTS.STATUS_STDERR,
      'dir=/x',
      'stderr=fatal: bad tree',
    );
  });

  it('emitSnapshotSyncCleanFailed 含 context + cleanupDir', () => {
    const audit = makeMockAuditLocal();
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
    const audit = makeMockAuditLocal();
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
    const audit = makeMockAuditLocal();
    emitSnapshotSyncCleanFailed(audit, { dir: '/x', reason: 'disk full' });
    expect(audit.write).toHaveBeenCalledWith(
      SNAPSHOT_AUDIT_EVENTS.SYNC_CLEAN_FAILED,
      'dir=/x',
      'reason=disk full',
    );
  });

  it('emitSnapshotSyncRestoreFailed serialize 正确', () => {
    const audit = makeMockAuditLocal();
    emitSnapshotSyncRestoreFailed(audit, { dir: '/x', restoreReason: 'disk full' });
    expect(audit.write).toHaveBeenCalledWith(
      SNAPSHOT_AUDIT_EVENTS.SYNC_RESTORE_FAILED,
      'dir=/x',
      'restoreReason=disk full',
    );
  });

  it('emitSnapshotDegraded serialize 正确', () => {
    const audit = makeMockAuditLocal();
    emitSnapshotDegraded(audit, { dir: '/x', consecutive: 3 });
    expect(audit.write).toHaveBeenCalledWith(
      SNAPSHOT_AUDIT_EVENTS.DEGRADED,
      'dir=/x',
      'consecutive=3',
    );
  });

  it('emitSnapshotPersistFailed serialize 正确', () => {
    const audit = makeMockAuditLocal();
    emitSnapshotPersistFailed(audit, { dir: '/x', reason: 'writeAtomic failed' });
    expect(audit.write).toHaveBeenCalledWith(
      SNAPSHOT_AUDIT_EVENTS.PERSIST_FAILED,
      'dir=/x',
      'reason=writeAtomic failed',
    );
  });

  // 反向 1（误删反向）：emit fn 内部 audit.write 删 → test fail
  it('反向 1: emit fn 实然调 audit.write', () => {
    const audit = makeMockAuditLocal();
    emitSnapshotInitFailed(audit, { dir: '/x', kind: 'corrupt' });
    expect(audit.write).toHaveBeenCalled();
  });

  // 反向 2（schema 反向）：payload key 错应 tsc fail
  it('反向 2: typed payload key TS enforce', () => {
    const audit = makeMockAuditLocal();
    // @ts-expect-error: typo 'msg' (should be 'message')
    emitSnapshotCommitted(audit, { dir: '/x', msg: 'hello' });
    expect(audit.write).toHaveBeenCalledTimes(1);
  });

  // 反向 3（边界路径反向）：optional field undefined 时不输出 col
  it('反向 3: optional field undefined 时 cols 不含该 key', () => {
    const audit = makeMockAuditLocal();
    emitSnapshotInitFailed(audit, { dir: '/x' }); // 无 kind + 无 context
    expect(audit.write).toHaveBeenCalledWith(SNAPSHOT_AUDIT_EVENTS.INIT_FAILED, 'dir=/x');
    // 确认 cols 数 = 1（仅 dir）
    expect((audit.write.mock.calls[0] as unknown as unknown[]).length).toBe(2); // event + dir col
  });
});

describe('version-store typed audit emit (phase 1918 Step B)', () => {
  const makeMockAuditLocal = makeMockAudit;

  it('emitSnapshotVersionInitFailed serialize 顺序正确（含 reason）', () => {
    const audit = makeMockAuditLocal();
    emitSnapshotVersionInitFailed(audit, { dir: '/x', kind: 'repo_invalid', reason: 'boom' });
    expect(audit.write).toHaveBeenCalledWith(
      SNAPSHOT_AUDIT_EVENTS.VERSION_INIT_FAILED, 'dir=/x', 'kind=repo_invalid', 'reason=boom');
  });

  it('emitSnapshotVersionInitFailed 无 reason 时不输出 col', () => {
    const audit = makeMockAuditLocal();
    emitSnapshotVersionInitFailed(audit, { dir: '/x', kind: 'repo_init_failed' });
    expect(audit.write).toHaveBeenCalledWith(
      SNAPSHOT_AUDIT_EVENTS.VERSION_INIT_FAILED, 'dir=/x', 'kind=repo_init_failed');
  });

  it('emitSnapshotVersionWorkspaceBegan serialize 顺序正确', () => {
    const audit = makeMockAuditLocal();
    emitSnapshotVersionWorkspaceBegan(audit, {
      dir: '/x', workspace: 'ws-1', base: 'b', branch: 'refs/version/workspaces/ws-1', operationId: 'op',
    });
    expect(audit.write).toHaveBeenCalledWith(
      SNAPSHOT_AUDIT_EVENTS.VERSION_WORKSPACE_BEGAN,
      'dir=/x', 'workspace=ws-1', 'base=b', 'branch=refs/version/workspaces/ws-1', 'operationId=op');
  });

  it('emitSnapshotVersionSaved 含 outcome=no_change；缺省不输出', () => {
    const audit = makeMockAuditLocal();
    emitSnapshotVersionSaved(audit, { dir: '/x', workspace: 'ws-1', version: 'v', operationId: 'op', outcome: 'no_change' });
    expect(audit.write).toHaveBeenCalledWith(
      SNAPSHOT_AUDIT_EVENTS.VERSION_SAVED, 'dir=/x', 'workspace=ws-1', 'version=v', 'operationId=op', 'outcome=no_change');
    const audit2 = makeMockAuditLocal();
    emitSnapshotVersionSaved(audit2, { dir: '/x', workspace: 'ws-1', version: 'v', operationId: 'op' });
    expect(audit2.write).toHaveBeenCalledWith(
      SNAPSHOT_AUDIT_EVENTS.VERSION_SAVED, 'dir=/x', 'workspace=ws-1', 'version=v', 'operationId=op');
  });

  it('emitSnapshotVersionSaveFailed 含 optional workspace/operationId', () => {
    const audit = makeMockAuditLocal();
    emitSnapshotVersionSaveFailed(audit, { dir: '/x', reason: 'r', workspace: 'ws-1', operationId: 'op' });
    expect(audit.write).toHaveBeenCalledWith(
      SNAPSHOT_AUDIT_EVENTS.VERSION_SAVE_FAILED, 'dir=/x', 'reason=r', 'workspace=ws-1', 'operationId=op');
  });

  it('反向：typed payload key TS enforce', () => {
    const audit = makeMockAuditLocal();
    // @ts-expect-error: typo 'msg' (should be 'reason')
    emitSnapshotVersionSaveFailed(audit, { dir: '/x', msg: 'r' });
    expect(audit.write).toHaveBeenCalledTimes(1);
  });
});

describe('version-store publish typed audit emit (phase 1918 Step C)', () => {
  const makeMockAuditLocal = makeMockAudit;

  it('emitSnapshotVersionPublished serialize 顺序正确（含 outcome=recovered）', () => {
    const audit = makeMockAuditLocal();
    emitSnapshotVersionPublished(audit, { dir: '/x', prefix: 'skills/a', version: 'v', operationId: 'op', outcome: 'recovered' });
    expect(audit.write).toHaveBeenCalledWith(
      SNAPSHOT_AUDIT_EVENTS.VERSION_PUBLISHED, 'dir=/x', 'prefix=skills/a', 'version=v', 'operationId=op', 'outcome=recovered');
    const audit2 = makeMockAuditLocal();
    emitSnapshotVersionPublished(audit2, { dir: '/x', prefix: 'skills/a', version: 'v', operationId: 'op' });
    expect(audit2.write).toHaveBeenCalledWith(
      SNAPSHOT_AUDIT_EVENTS.VERSION_PUBLISHED, 'dir=/x', 'prefix=skills/a', 'version=v', 'operationId=op');
  });

  it('emitSnapshotVersionPublishConflict serialize 顺序正确', () => {
    const audit = makeMockAuditLocal();
    emitSnapshotVersionPublishConflict(audit, { dir: '/x', prefix: 'skills/a', current: 'c', candidate: 'k', operationId: 'op' });
    expect(audit.write).toHaveBeenCalledWith(
      SNAPSHOT_AUDIT_EVENTS.VERSION_PUBLISH_CONFLICT,
      'dir=/x', 'prefix=skills/a', 'current=c', 'candidate=k', 'operationId=op');
  });

  it('emitSnapshotVersionPublishBusy serialize 顺序正确', () => {
    const audit = makeMockAuditLocal();
    emitSnapshotVersionPublishBusy(audit, { dir: '/x', prefix: 'skills/a', operationId: 'op', attempts: 3 });
    expect(audit.write).toHaveBeenCalledWith(
      SNAPSHOT_AUDIT_EVENTS.VERSION_PUBLISH_BUSY, 'dir=/x', 'prefix=skills/a', 'operationId=op', 'attempts=3');
  });

  it('emitSnapshotVersionPublishFailed 含 optional prefix/operationId；缺省不输出', () => {
    const audit = makeMockAuditLocal();
    emitSnapshotVersionPublishFailed(audit, { dir: '/x', reason: 'r', prefix: 'skills/a', operationId: 'op' });
    expect(audit.write).toHaveBeenCalledWith(
      SNAPSHOT_AUDIT_EVENTS.VERSION_PUBLISH_FAILED, 'dir=/x', 'reason=r', 'prefix=skills/a', 'operationId=op');
    const audit2 = makeMockAuditLocal();
    emitSnapshotVersionPublishFailed(audit2, { dir: '/x', reason: 'r' });
    expect(audit2.write).toHaveBeenCalledWith(SNAPSHOT_AUDIT_EVENTS.VERSION_PUBLISH_FAILED, 'dir=/x', 'reason=r');
  });
});

describe('version-store export typed audit emit (phase 1918 Step D)', () => {
  const makeMockAuditLocal = makeMockAudit;

  it('emitSnapshotVersionExported serialize 顺序正确', () => {
    const audit = makeMockAuditLocal();
    emitSnapshotVersionExported(audit, { dir: '/x', version: 'v', prefix: 'skills/a', destination: '/d' });
    expect(audit.write).toHaveBeenCalledWith(
      SNAPSHOT_AUDIT_EVENTS.VERSION_EXPORTED, 'dir=/x', 'version=v', 'prefix=skills/a', 'destination=/d');
  });

  it('emitSnapshotVersionExportFailed 含 optional 字段；缺省不输出', () => {
    const audit = makeMockAuditLocal();
    emitSnapshotVersionExportFailed(audit, { dir: '/x', reason: 'r', version: 'v', prefix: 'skills/a', destination: '/d' });
    expect(audit.write).toHaveBeenCalledWith(
      SNAPSHOT_AUDIT_EVENTS.VERSION_EXPORT_FAILED, 'dir=/x', 'reason=r', 'version=v', 'prefix=skills/a', 'destination=/d');
    const audit2 = makeMockAuditLocal();
    emitSnapshotVersionExportFailed(audit2, { dir: '/x', reason: 'r' });
    expect(audit2.write).toHaveBeenCalledWith(SNAPSHOT_AUDIT_EVENTS.VERSION_EXPORT_FAILED, 'dir=/x', 'reason=r');
  });
});
