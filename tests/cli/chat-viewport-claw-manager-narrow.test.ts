/**
 * Phase 1215: chat-viewport-claw-manager refreshAllClawStatus isFileNotFound dual-code narrow
 *
 * 反向测试（fs.listSync narrow）：
 * 1. FileNotFoundError (FileSystem abstract layer FS_NOT_FOUND) → 0 audit emit
 * 2. raw ENOENT → 0 audit emit
 * 3. EACCES → emit REFRESH_CLAWS_FAILED
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createClawManager } from '../../src/cli/commands/chat-viewport-claw-manager.js';
import { FileNotFoundError } from '../../src/foundation/fs/types.js';
import { VIEWPORT_AUDIT_EVENTS } from '../../src/cli/commands/viewport-audit-events.js';
import type { FileSystem } from '../../src/foundation/fs/types.js';
import type { AuditLog } from '../../src/foundation/audit/index.js';

vi.mock('../../src/foundation/process-exec/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/process-exec/index.js')>();
  return {
    ...actual,
    isAlive: vi.fn().mockReturnValue(true),
  };
});

function makeMockFs(overrides?: {
  listSync?: () => ReturnType<FileSystem['listSync']>;
}): FileSystem {
  return {
    readSync: vi.fn(),
    read: vi.fn(),
    writeAtomic: vi.fn(),
    writeAtomicSync: vi.fn(),
    append: vi.fn(),
    appendSync: vi.fn(),
    delete: vi.fn(),
    move: vi.fn(),
    ensureDir: vi.fn(),
    removeDir: vi.fn(),
    list: vi.fn(),
    realpath: vi.fn(),
    exists: vi.fn(),
    isDirectory: vi.fn(),
    stat: vi.fn(),
    writeExclusiveSync: vi.fn(),
    readBytesSync: vi.fn(),
    statSync: vi.fn(),
    listSync: overrides?.listSync ?? vi.fn().mockReturnValue([]),
  } as unknown as FileSystem;
}

describe('chat-viewport-claw-manager dual-code narrow (phase 1215)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('reverse 1: fs.listSync throws FileNotFoundError → 0 audit emit', async () => {
    const audit = { write: vi.fn() };
    const mockFs = makeMockFs({
      listSync: vi.fn().mockImplementation(() => {
        throw new FileNotFoundError('/tmp/claws');
      }),
    });

    const manager = createClawManager({
      fs: mockFs,
      pm: { readPid: vi.fn().mockResolvedValue(null) },
      audit: audit as unknown as AuditLog,
      isMotion: true,
      clawsDir: '/tmp/claws',
      clawTrackMap: new Map(),
      updateClawPanel: vi.fn(),
      requestRender: vi.fn(),
    });

    await manager.refreshAllClawStatus();

    expect(audit.write).not.toHaveBeenCalled();
  });

  it('reverse 2: fs.listSync throws raw ENOENT → 0 audit emit', async () => {
    const audit = { write: vi.fn() };
    const err = Object.assign(new Error('no such file'), { code: 'ENOENT' });
    const mockFs = makeMockFs({
      listSync: vi.fn().mockImplementation(() => {
        throw err;
      }),
    });

    const manager = createClawManager({
      fs: mockFs,
      pm: { readPid: vi.fn().mockResolvedValue(null) },
      audit: audit as unknown as AuditLog,
      isMotion: true,
      clawsDir: '/tmp/claws',
      clawTrackMap: new Map(),
      updateClawPanel: vi.fn(),
      requestRender: vi.fn(),
    });

    await manager.refreshAllClawStatus();

    expect(audit.write).not.toHaveBeenCalled();
  });

  it('reverse 3: fs.listSync throws EACCES → emit REFRESH_CLAWS_FAILED', async () => {
    const audit = { write: vi.fn() };
    const err = Object.assign(new Error('Permission denied'), { code: 'EACCES' });
    const mockFs = makeMockFs({
      listSync: vi.fn().mockImplementation(() => {
        throw err;
      }),
    });

    const manager = createClawManager({
      fs: mockFs,
      pm: { readPid: vi.fn().mockResolvedValue(null) },
      audit: audit as unknown as AuditLog,
      isMotion: true,
      clawsDir: '/tmp/claws',
      clawTrackMap: new Map(),
      updateClawPanel: vi.fn(),
      requestRender: vi.fn(),
    });

    await manager.refreshAllClawStatus();

    expect(audit.write).toHaveBeenCalledTimes(1);
    expect(audit.write).toHaveBeenCalledWith(
      VIEWPORT_AUDIT_EVENTS.REFRESH_CLAWS_FAILED,
      expect.stringContaining('code=EACCES'),
      expect.stringContaining('error='),
    );
  });
});
