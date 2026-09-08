import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BlockIdIndex, DIALOG_AUDIT_EVENTS } from '../../../src/foundation/dialog-store/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { makeAudit } from '../../helpers/audit.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import snapshot from '../../../src/cli/audit-events.snapshot.json';

/**
 * phase 1822 (block-index-event-outside-catalog):
 * BlockIdIndex.load 的真实失败路径必须发射 owner catalog 内已登记的
 * block_id_index_load_failed 事件（值与 CLI 快照一致），成功/ENOENT 不新增事件。
 * 不使用 vi.mock：通过真实 NodeFileSystem + 边界注入驱动真实 load。
 */

/** 只让 readSync 抛 I/O 错误的真实 fs（load 的其余路径不变） */
class IndexReadUnavailableFs extends NodeFileSystem {
  override readSync(_relativePath: string): string {
    throw new Error('index read unavailable');
  }
}

describe('block index audit catalog', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createTempDir('chestnut-test-');
  });

  afterEach(async () => {
    await cleanupTempDir(dir);
  });

  it('shape failure emits the registered event and unchanged reason', async () => {
    const fs = new NodeFileSystem({ baseDir: dir });
    const index = new BlockIdIndex(fs, '');
    await fs.writeAtomic(index.indexPath, '[]');

    const { audit, events } = makeAudit();
    index.load(audit);

    expect(events).toEqual([[
      DIALOG_AUDIT_EVENTS.BLOCK_ID_INDEX_LOAD_FAILED,
      'reason=Error: BlockIdIndex: root must be a plain object',
    ]]);
    expect(DIALOG_AUDIT_EVENTS.BLOCK_ID_INDEX_LOAD_FAILED)
      .toBe('block_id_index_load_failed');
    expect(snapshot.modules['foundation_dialog-store_audit-events'])
      .toContain('block_id_index_load_failed');
    expect(await fs.read(index.indexPath)).toBe('[]');
  });

  it('missing index file is ENOENT recovery without any event', async () => {
    const fs = new NodeFileSystem({ baseDir: dir });
    const index = new BlockIdIndex(fs, '');

    const { audit, events } = makeAudit();
    index.load(audit);

    expect(events).toEqual([]);
    expect(index.size).toBe(0);
  });

  it('valid index file resolves without any event', async () => {
    const fs = new NodeFileSystem({ baseDir: dir });
    const index = new BlockIdIndex(fs, '');
    await fs.writeAtomic(index.indexPath, '{"abcdefgh":"full-id"}');

    const { audit, events } = makeAudit();
    index.load(audit);

    expect(index.resolve('abcdefgh')).toBe('full-id');
    expect(events).toEqual([]);
  });

  it('raw read failure emits exactly one registered event with stable reason', async () => {
    const index = new BlockIdIndex(new IndexReadUnavailableFs({ baseDir: dir }), '');

    const { audit, events } = makeAudit();
    index.load(audit);

    expect(events).toEqual([[
      DIALOG_AUDIT_EVENTS.BLOCK_ID_INDEX_LOAD_FAILED,
      'reason=Error: index read unavailable',
    ]]);
    expect(index.size).toBe(0);
  });
});
