/**
 * Phase 984 — DialogStore I/O vs corruption separation tests.
 */

import { describe, it, expect, vi } from 'vitest';
import { DialogStore } from '../../../src/foundation/dialog-store/store.js';
import { applyBlockIdAssignments } from '../../../src/foundation/dialog-store/apply-block-ids.js';
import { DIALOG_AUDIT_EVENTS } from '../../../src/foundation/dialog-store/audit-events.js';
import { DialogIOError, CorruptionError } from '../../../src/foundation/dialog-store/errors.js';
import type { DialogSaveSnapshot } from '../../../src/foundation/dialog-store/types.js';
import type { FileSystem, FileEntry } from '../../../src/foundation/fs/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import { makeSession } from '../../helpers/session-fixtures.js';

function makeMockAudit() {
  return { write: vi.fn() };
}

function makeMockFs(opts: {
  currentReadError?: Error;
  currentContent?: string;
  archives?: Array<{ name: string; content: string }>;
  archiveReadError?: Error;
  listError?: Error;
  existsReturns?: boolean;
  currentWriteError?: Error;
  indexWriteError?: Error;
}): FileSystem {
  const archiveMap = new Map(opts.archives?.map(a => [`dialog/archive/${a.name}`, a.content]));
  return {
    read: vi.fn(async (p: string) => {
      if (p === 'dialog/current.json') {
        if (opts.currentReadError) throw opts.currentReadError;
        if (opts.currentContent !== undefined) return opts.currentContent;
        const err = new Error(`ENOENT: ${p}`) as any;
        err.code = 'ENOENT';
        throw err;
      }
      if (archiveMap.has(p)) {
        if (opts.archiveReadError) throw opts.archiveReadError;
        return archiveMap.get(p)!;
      }
      const err = new Error(`ENOENT: ${p}`) as any;
      err.code = 'ENOENT';
      throw err;
    }),
    list: vi.fn(async (p: string) => {
      if (opts.listError) throw opts.listError;
      if (p === 'dialog/archive') {
        return (opts.archives ?? []).map((a, i) => ({
          name: a.name,
          path: `dialog/archive/${a.name}`,
          isFile: true,
          isDirectory: false,
          size: a.content.length,
          mtime: new Date(1000 + i),
        } as FileEntry));
      }
      return [];
    }),
    ensureDir: vi.fn(async () => {}),
    writeAtomic: vi.fn(async (p: string) => {
      if (opts.currentWriteError && p === 'dialog/current.json') throw opts.currentWriteError;
    }),
    move: vi.fn(async () => {}),
    append: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    exists: vi.fn(async () => opts.existsReturns ?? false),
    isDirectory: vi.fn(async () => false),
    stat: vi.fn(async () => ({ size: 0, mtime: new Date(), ctime: new Date(), isFile: true, isDirectory: false })),
    writeAtomicSync: vi.fn((p: string) => {
      if (opts.indexWriteError && p === 'dialog/block-index.json') throw opts.indexWriteError;
    }),
    writeExclusiveSync: vi.fn(() => {}),
    readSync: vi.fn(() => ''),
    readBytesSync: vi.fn(() => Buffer.from('')),
    appendSync: vi.fn(() => {}),
    statSync: vi.fn(() => ({ size: 0, mtime: new Date(), ctime: new Date(), isFile: true, isDirectory: false })),
    moveSync: vi.fn(() => {}),
    existsSync: vi.fn(() => false),
    ensureDirSync: vi.fn(() => {}),
    listSync: vi.fn(() => []),
    deleteSync: vi.fn(() => {}),
    resolve: vi.fn((p: string) => `/base/${p}`),
  } as unknown as FileSystem;
}

describe('DialogStore I/O vs corruption separation (phase 984)', () => {
  it('propagates current.json I/O error without isolating the file', async () => {
    const audit = makeMockAudit();
    const fs = makeMockFs({
      currentReadError: Object.assign(new Error('EIO'), { code: 'EIO' }),
    });
    const store = new DialogStore(fs, 'dialog', audit as unknown as AuditLog, 'current.json', 'c1');

    const result = await store.load();

    expect(result.source).toBe('io_error');
    expect(result.error).toContain('EIO');
    expect(fs.move).not.toHaveBeenCalled();
    const loadFailed = audit.write.mock.calls.filter((c: any[]) => c[0] === DIALOG_AUDIT_EVENTS.LOAD_FAILED);
    expect(loadFailed.length).toBe(1);
    expect(loadFailed[0][1]).toContain('file=current.json');
  });

  it('returns null session on I/O error (phase 987 discriminated union)', async () => {
    const audit = makeMockAudit();
    const fs = makeMockFs({
      currentReadError: Object.assign(new Error('EIO'), { code: 'EIO' }),
    });
    const store = new DialogStore(fs, 'dialog', audit as unknown as AuditLog, 'current.json', 'c1');

    const result = await store.load();

    expect(result.source).toBe('io_error');
    expect(result.session).toBeNull();
  });

  it('isolates corrupted current.json to a timestamped filename', async () => {
    const audit = makeMockAudit();
    const fs = makeMockFs({ currentContent: 'not valid json {{{' });
    const store = new DialogStore(fs, 'dialog', audit as unknown as AuditLog, 'current.json', 'c1');

    const result = await store.load();

    expect(result.source).toBe('empty');
    expect(fs.move).toHaveBeenCalledWith(
      'dialog/current.json',
      expect.stringMatching(/dialog\/current\.json\.corrupted\.\d+_[a-z0-9]+/),
    );
    const corrupted = audit.write.mock.calls.filter(
      (c: any[]) => c[0] === DIALOG_AUDIT_EVENTS.CORRUPTED && c[1] && c[1].includes('file=current.json'),
    );
    expect(corrupted.length).toBeGreaterThanOrEqual(1);
  });

  it('propagates archive directory read failure instead of cold-starting', async () => {
    const audit = makeMockAudit();
    const fs = makeMockFs({
      listError: Object.assign(new Error('EACCES'), { code: 'EACCES' }),
    });
    const store = new DialogStore(fs, 'dialog', audit as unknown as AuditLog, 'current.json', 'c1');

    await expect((store as any).loadLatestArchive()).rejects.toThrow('EACCES');
  });

  it('retries current.json when corruptedPoisoned and the file reappears', async () => {
    const audit = makeMockAudit();
    const fs = makeMockFs({
      existsReturns: true,
      currentContent: JSON.stringify(makeSession({
        clawId: 'c1',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        systemPrompt: 'sp',
        messages: [{ role: 'user', content: 'hello' }],
      })),
    });
    const store = new DialogStore(fs, 'dialog', audit as unknown as AuditLog, 'current.json', 'c1');
    (store as any).corruptedPoisoned = true;

    const result = await store.load();

    expect(result.source).toBe('current');
    expect((store as any).corruptedPoisoned).toBe(false);
  });

  it('Phase 990: readArchive throws DialogIOError on I/O read failure', async () => {
    const audit = makeMockAudit();
    const fs = makeMockFs({
      archives: [{ name: '1000_archive.json', content: '{}' }],
      archiveReadError: Object.assign(new Error('EIO'), { code: 'EIO' }),
    });
    const store = new DialogStore(fs, 'dialog', audit as unknown as AuditLog, 'current.json', 'c1');

    await expect(store.readArchive('1000_archive.json')).rejects.toBeInstanceOf(DialogIOError);
  });

  it('Phase 990: readArchive throws CorruptionError on JSON parse failure', async () => {
    const audit = makeMockAudit();
    const fs = makeMockFs({
      archives: [{ name: '1000_archive.json', content: 'not valid json {{{' }],
    });
    const store = new DialogStore(fs, 'dialog', audit as unknown as AuditLog, 'current.json', 'c1');

    await expect(store.readArchive('1000_archive.json')).rejects.toBeInstanceOf(CorruptionError);
  });
});

describe('DialogStore save two-file commit protocol (phase 1850 Step B)', () => {
  // array-content block 无 blockId → save 分配 ID 并置 index dirty（驱动 index save 路径）
  const makeSnapshot = (): DialogSaveSnapshot => ({
    systemPrompt: 'sp',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    toolsForLLM: [],
  });

  it('index write failure: main snapshot committed, no reject, structured false + one audit line', async () => {
    const audit = makeMockAudit();
    const fs = makeMockFs({ indexWriteError: Object.assign(new Error('EIO index'), { code: 'EIO' }) });
    const store = new DialogStore(fs, 'dialog', audit as unknown as AuditLog, 'current.json', 'c1');

    const result = await store.save(makeSnapshot());

    expect(result.blockIndexPersisted).toBe(false);
    // 主快照已提交（caller 可从磁盘交付校验）
    expect(fs.writeAtomic).toHaveBeenCalledWith('dialog/current.json', expect.any(String));
    const written = JSON.parse(vi.mocked(fs.writeAtomic).mock.calls[0][1] as string);
    expect(written.messages).toHaveLength(1);
    // index 失败不静默：恰一行新事件、无 SAVE_FAILED
    const indexFailed = audit.write.mock.calls.filter(
      (c: any[]) => c[0] === DIALOG_AUDIT_EVENTS.BLOCK_ID_INDEX_SAVE_FAILED,
    );
    expect(indexFailed.length).toBe(1);
    expect(indexFailed[0][1]).toBe('path=dialog/block-index.json');
    const saveFailed = audit.write.mock.calls.filter(
      (c: any[]) => c[0] === DIALOG_AUDIT_EVENTS.SAVE_FAILED,
    );
    expect(saveFailed.length).toBe(0);
  });

  it('main snapshot failure: rejects with SAVE_FAILED and index gets no write', async () => {
    const audit = makeMockAudit();
    const fs = makeMockFs({ currentWriteError: Object.assign(new Error('EIO current'), { code: 'EIO' }) });
    const store = new DialogStore(fs, 'dialog', audit as unknown as AuditLog, 'current.json', 'c1');

    await expect(store.save(makeSnapshot())).rejects.toThrow('EIO current');

    const saveFailed = audit.write.mock.calls.filter(
      (c: any[]) => c[0] === DIALOG_AUDIT_EVENTS.SAVE_FAILED,
    );
    expect(saveFailed.length).toBe(1);
    expect(saveFailed[0][1]).toBe('path=dialog/current.json');
    // dialog 失败不产生 index 先行写入
    expect(fs.writeAtomicSync).not.toHaveBeenCalled();
    const indexFailed = audit.write.mock.calls.filter(
      (c: any[]) => c[0] === DIALOG_AUDIT_EVENTS.BLOCK_ID_INDEX_SAVE_FAILED,
    );
    expect(indexFailed.length).toBe(0);
  });

  it('next save retries index persistence after an index write failure (dirty 语义)', async () => {
    const audit = makeMockAudit();
    const fs = makeMockFs({ indexWriteError: Object.assign(new Error('EIO index'), { code: 'EIO' }) });
    const store = new DialogStore(fs, 'dialog', audit as unknown as AuditLog, 'current.json', 'c1');

    const first = await store.save(makeSnapshot());
    expect(first.blockIndexPersisted).toBe(false);

    vi.mocked(fs.writeAtomicSync).mockImplementation(() => {});
    const second = await store.save(makeSnapshot());

    expect(second.blockIndexPersisted).toBe(true);
    expect(fs.writeAtomicSync).toHaveBeenCalledWith('dialog/block-index.json', expect.any(String));
  });
});

describe('DialogStore save caller-data immutability (phase 1850 Step C)', () => {
  const makeBlockSnapshot = (): DialogSaveSnapshot => ({
    systemPrompt: 'sp',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    toolsForLLM: [],
  });

  it('save 不改 caller 传入对象：deep-equal 不变、blockId 不落 caller 块、Object.freeze 不抛', async () => {
    const audit = makeMockAudit();
    const fs = makeMockFs({});
    const store = new DialogStore(fs, 'dialog', audit as unknown as AuditLog, 'current.json', 'c1');
    const snapshot = makeBlockSnapshot();
    const before = JSON.parse(JSON.stringify(snapshot.messages));
    Object.freeze(snapshot.messages);
    Object.freeze(snapshot.messages[0]);
    Object.freeze((snapshot.messages[0].content as unknown[])[0]);

    const result = await store.save(snapshot);

    // ① caller 消息对象与调用前 deep-equal 且未被写入 blockId（freeze 下旧实现会抛 TypeError）
    expect(snapshot.messages).toEqual(before);
    expect(((snapshot.messages[0].content as any[])[0] as any).blockId).toBeUndefined();
    expect(result.assignedBlockIds).toHaveLength(1);
    expect(result.assignedBlockIds[0].messageIndex).toBe(0);
    expect(result.assignedBlockIds[0].blockIndex).toBe(0);
    // 反向③：落盘内容（clone）携带所分配 ID、与 assignments 一致
    const written = JSON.parse(vi.mocked(fs.writeAtomic).mock.calls[0][1] as string);
    expect(written.messages[0].content[0].blockId).toBe(result.assignedBlockIds[0].blockId);
    // ③ index 内容与 assignments 一一对应
    expect((store as any).blockIdIndex.resolve(result.assignedBlockIds[0].shortId))
      .toBe(result.assignedBlockIds[0].blockId);
  });

  it('应用 assignments 后两连 save 同一数组 → 第二次 assignments 为空（不重复分配）', async () => {
    const audit = makeMockAudit();
    const fs = makeMockFs({});
    const store = new DialogStore(fs, 'dialog', audit as unknown as AuditLog, 'current.json', 'c1');
    const snapshot = makeBlockSnapshot();

    const first = await store.save(snapshot);
    expect(first.assignedBlockIds).toHaveLength(1);
    applyBlockIdAssignments(snapshot.messages, first.assignedBlockIds);
    const callerBlockId = ((snapshot.messages[0].content as any[])[0] as any).blockId;
    expect(callerBlockId).toBe(first.assignedBlockIds[0].blockId);

    const second = await store.save(snapshot);
    expect(second.assignedBlockIds).toEqual([]);
    // ② 反向：已带 blockId 不重分配——caller 块 ID 稳定
    expect(((snapshot.messages[0].content as any[])[0] as any).blockId).toBe(callerBlockId);
  });

  it('未应用回传时两连 save 同一数组 → clone 重复分配（已知边界行为锁定）', async () => {
    const audit = makeMockAudit();
    const fs = makeMockFs({});
    const store = new DialogStore(fs, 'dialog', audit as unknown as AuditLog, 'current.json', 'c1');
    const snapshot = makeBlockSnapshot();

    const first = await store.save(snapshot);
    const second = await store.save(snapshot);

    expect(first.assignedBlockIds).toHaveLength(1);
    expect(second.assignedBlockIds).toHaveLength(1);
    expect(second.assignedBlockIds[0].blockId).not.toBe(first.assignedBlockIds[0].blockId);
  });

  it('已带 blockId 的块不重分配、不进 assignments', async () => {
    const audit = makeMockAudit();
    const fs = makeMockFs({});
    const store = new DialogStore(fs, 'dialog', audit as unknown as AuditLog, 'current.json', 'c1');
    const snapshot: DialogSaveSnapshot = {
      systemPrompt: 'sp',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', blockId: 'existing-full-id' } as any] }],
      toolsForLLM: [],
    };

    const result = await store.save(snapshot);

    expect(result.assignedBlockIds).toEqual([]);
    const written = JSON.parse(vi.mocked(fs.writeAtomic).mock.calls[0][1] as string);
    expect(written.messages[0].content[0].blockId).toBe('existing-full-id');
  });
});
