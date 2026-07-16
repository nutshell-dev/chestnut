/**
 * phase 281 Step B: legacy summon-state/ directory detection tests.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { checkLegacySummonStateFiles } from '../../../src/core/summon-system/legacy-state-detection.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { FileNotFoundError } from '../../../src/foundation/fs/index.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import * as fsSync from 'node:fs';

function makeFakeAudit(): AuditLog & { entries: string[][] } {
  const entries: string[][] = [];
  return {
    entries,
    write(event: string, ...cols: string[]) {
      entries.push([event, ...cols]);
    },
  };
}

let lastDir: string;

async function createTempFs() {
  // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
  const dir = path.join(os.tmpdir(), `summon-legacy-test-${randomUUID()}`);
  lastDir = dir;
  const fs = new NodeFileSystem({ baseDir: dir });
  return { fs, dir };
}

describe('checkLegacySummonStateFiles (phase 281 Step B)', () => {
  afterEach(() => {
    if (lastDir) {
      try {
        fsSync.rmSync(lastDir, { recursive: true, force: true });
      } catch (e: any) {
        if (e?.code !== 'ENOENT') throw e;
      }
      lastDir = '';
    }
  });
  it('无 summon-state/ 目录 → 0 emit', async () => {
    const { fs } = await createTempFs();
    const audit = makeFakeAudit();
    await checkLegacySummonStateFiles(fs, audit);
    expect(audit.entries).toHaveLength(0);
  });

  it('summon-state/ 空目录 → 0 emit', async () => {
    const { fs } = await createTempFs();
    const audit = makeFakeAudit();
    await fs.ensureDir('summon-state');
    await checkLegacySummonStateFiles(fs, audit);
    expect(audit.entries).toHaveLength(0);
  });

  it('summon-state/ 含残留文件 → emit SUMMON_LEGACY_STATE_FILE_DETECTED', async () => {
    const { fs } = await createTempFs();
    const audit = makeFakeAudit();
    await fs.ensureDir('summon-state');
    await fs.writeAtomic('summon-state/old-task-1.json', JSON.stringify({ taskId: 'old-task-1' }));
    await fs.writeAtomic('summon-state/old-task-2.json', JSON.stringify({ taskId: 'old-task-2' }));

    await checkLegacySummonStateFiles(fs, audit);

    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0][0]).toBe('summon_legacy_state_file_detected');
    expect(audit.entries[0][1]).toContain('count=2');
    expect(audit.entries[0][2]).toContain('dir=summon-state');
    expect(audit.entries[0][3]).toContain('action=manual_cleanup_required');
  });

  it('audit=undefined → 不抛、0 emit', async () => {
    const { fs } = await createTempFs();
    await fs.ensureDir('summon-state');
    await fs.writeAtomic('summon-state/old-task.json', '{}');
    await expect(checkLegacySummonStateFiles(fs, undefined)).resolves.toBeUndefined();
  });

  it('fs.exists throw FS_NOT_FOUND → 0 emit', async () => {
    const { fs } = await createTempFs();
    const audit = makeFakeAudit();
    const originalExists = fs.exists.bind(fs);
    fs.exists = async () => { throw new FileNotFoundError('summon-state'); };
    await checkLegacySummonStateFiles(fs, audit);
    expect(audit.entries).toHaveLength(0);
    fs.exists = originalExists;
  });

  it('fs.exists throw 其他错误 → emit error=exists_failed', async () => {
    const { fs } = await createTempFs();
    const audit = makeFakeAudit();
    const originalExists = fs.exists.bind(fs);
    fs.exists = async () => { throw new Error('exists failed'); };
    await checkLegacySummonStateFiles(fs, audit);
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0][0]).toBe('summon_legacy_state_file_detected');
    expect(audit.entries[0][1]).toContain('dir=summon-state');
    expect(audit.entries[0][2]).toContain('error=exists_failed');
    expect(audit.entries[0][3]).toContain('reason=');
    fs.exists = originalExists;
  });

  it('fs.list throw FS_NOT_FOUND → 0 emit', async () => {
    const { fs } = await createTempFs();
    const audit = makeFakeAudit();
    await fs.ensureDir('summon-state');
    const originalList = fs.list.bind(fs);
    fs.list = async () => { throw new FileNotFoundError('summon-state'); };
    await checkLegacySummonStateFiles(fs, audit);
    expect(audit.entries).toHaveLength(0);
    fs.list = originalList;
  });

  it('fs.list throw 其他错误 → emit error=list_failed', async () => {
    const { fs } = await createTempFs();
    const audit = makeFakeAudit();
    await fs.ensureDir('summon-state');
    const originalList = fs.list.bind(fs);
    fs.list = async () => { throw new Error('list failed'); };
    await checkLegacySummonStateFiles(fs, audit);
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0][0]).toBe('summon_legacy_state_file_detected');
    expect(audit.entries[0][1]).toContain('dir=summon-state');
    expect(audit.entries[0][2]).toContain('error=list_failed');
    expect(audit.entries[0][3]).toContain('reason=');
    fs.list = originalList;
  });
});
