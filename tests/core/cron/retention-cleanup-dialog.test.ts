import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fsSync from 'fs';
import { runRetentionCleanup } from '../../../src/core/cron/jobs/retention-cleanup.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { CRON_AUDIT_EVENTS } from '../../../src/core/cron/audit-events.js';
import { cleanupTempDirSync } from '../../utils/temp.js';

describe('runRetentionCleanup > dialog/archive', () => {
  let tmpDir: string;
  let archiveDir: string;

  beforeEach(() => {
    tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'phase1111-dialog-'));
    archiveDir = path.join(tmpDir, 'dialog', 'archive');
    fsSync.mkdirSync(archiveDir, { recursive: true });
  });

  afterEach(() => {
    cleanupTempDirSync(tmpDir);
  });

  function makeAudit() {
    const writes: Array<{ type: string; cols: string[] }> = [];
    const audit = { write: (t: string, ...c: string[]) => writes.push({ type: t, cols: c }) };
    return { audit, writes };
  }

  it('主路径：删过 cutoff 的 dialog archive 文件 + 保留新文件 + emit RETENTION_CLEANUP audit', async () => {
    const oldFile = path.join(archiveDir, 'old-dialog.jsonl');
    const newFile = path.join(archiveDir, 'new-dialog.jsonl');
    fsSync.writeFileSync(oldFile, 'x');
    fsSync.writeFileSync(newFile, 'y');

    const past = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    fsSync.utimesSync(oldFile, past, past);

    const { audit, writes } = makeAudit();
    const nodeFs = new NodeFileSystem({ baseDir: tmpDir });

    await runRetentionCleanup({
      motionDir: tmpDir,
      fs: nodeFs,
      audit,
      maxDays: { inbox: 30, outbox: 30, tasks: 60, dialog: 90 },
    });

    expect(fsSync.existsSync(oldFile)).toBe(false);
    expect(fsSync.existsSync(newFile)).toBe(true);
    expect(writes.some(w => w.type === CRON_AUDIT_EVENTS.RETENTION_CLEANUP && w.cols.some(c => c.includes('deleted=')))).toBe(true);
  });

  it('边界：maxDays.dialog undefined 时 0 删 + 仍 emit RETENTION_CLEANUP', async () => {
    const oldFile = path.join(archiveDir, 'old.jsonl');
    fsSync.writeFileSync(oldFile, 'x');

    const past = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    fsSync.utimesSync(oldFile, past, past);

    const { audit, writes } = makeAudit();
    const nodeFs = new NodeFileSystem({ baseDir: tmpDir });

    await runRetentionCleanup({
      motionDir: tmpDir,
      fs: nodeFs,
      audit,
      maxDays: { inbox: 30, outbox: 30, tasks: 60 },
    });

    expect(fsSync.existsSync(oldFile)).toBe(true);
    expect(writes.some(w => w.type === CRON_AUDIT_EVENTS.RETENTION_CLEANUP && w.cols.some(c => c.includes('deleted=0')))).toBe(true);
  });

  it('边界：archiveDir 不存在时不报错', async () => {
    fsSync.rmSync(archiveDir, { recursive: true, force: true });

    const { audit } = makeAudit();
    const nodeFs = new NodeFileSystem({ baseDir: tmpDir });

    await expect(runRetentionCleanup({
      motionDir: tmpDir,
      fs: nodeFs,
      audit,
      maxDays: { inbox: 30, outbox: 30, tasks: 60, dialog: 90 },
    })).resolves.toBeUndefined();
  });

  it('边界：archive 下子目录内文件不被 traverse（isDirectory 跳过）', async () => {
    const subDir = path.join(archiveDir, 'subdir');
    fsSync.mkdirSync(subDir);
    const subFile = path.join(subDir, 'inside.jsonl');
    fsSync.writeFileSync(subFile, 'x');

    const past = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    fsSync.utimesSync(subFile, past, past);

    const { audit, writes } = makeAudit();
    const nodeFs = new NodeFileSystem({ baseDir: tmpDir });

    await runRetentionCleanup({
      motionDir: tmpDir,
      fs: nodeFs,
      audit,
      maxDays: { inbox: 30, outbox: 30, tasks: 60, dialog: 90 },
    });

    expect(fsSync.existsSync(subFile)).toBe(true);
    expect(writes.some(w => w.type === CRON_AUDIT_EVENTS.RETENTION_CLEANUP && w.cols.some(c => c.includes('deleted=')))).toBe(true);
  });
});
