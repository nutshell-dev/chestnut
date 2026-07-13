/**
 * phase 281 Step B: legacy summon-state/ directory detection tests.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { checkLegacySummonStateFiles } from '../../../src/core/summon-system/legacy-state-detection.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
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

  it('fs.list throw → catch 不抛、不 emit', async () => {
    const { fs } = await createTempFs();
    const audit = makeFakeAudit();
    await fs.ensureDir('summon-state');
    // 用无权限文件模拟 list 失败：在 summon-state 下放一个非目录同名路径不可行，
    // 这里直接 spy exists 返回 true 且 list 抛错来测试韧性。
    const originalList = fs.list.bind(fs);
    fs.list = async () => { throw new Error('list failed'); };
    await checkLegacySummonStateFiles(fs, audit);
    expect(audit.entries).toHaveLength(0);
    fs.list = originalList;
  });
});
