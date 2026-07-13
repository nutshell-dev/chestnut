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
import type { ClawTopology } from '../../src/core/claw-topology/index.js';

function makeMockTopology(clawsDir: string, overrides?: {
  enumerate?: () => string[];
}): ClawTopology {
  return {
    enumerate: overrides?.enumerate ?? vi.fn().mockReturnValue([]),
    resolve: vi.fn((clawId: string) => ({ kind: 'local', clawDir: `${clawsDir}/${clawId}` })),
    read: vi.fn(),
    readJSON: vi.fn(),
  } as unknown as ClawTopology;
}

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
    const audit = { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)};
    const mockFs = makeMockFs({
      listSync: vi.fn().mockImplementation(() => {
        // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
        throw new FileNotFoundError('/tmp/claws');
      }),
    });

    const manager = createClawManager({
      fs: mockFs,
      pm: { readPid: vi.fn().mockResolvedValue(null) },
      audit: audit as unknown as AuditLog,
      isMotion: true,
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      clawsDir: '/tmp/claws',
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      clawTopology: makeMockTopology('/tmp/claws'),
      clawTrackMap: new Map(),
      updateClawPanel: vi.fn(),
      requestRender: vi.fn(),
    });

    await manager.refreshAllClawStatus();

    expect(audit.write).not.toHaveBeenCalled();
  });

  it('reverse 2: fs.listSync throws raw ENOENT → 0 audit emit', async () => {
    const audit = { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)};
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
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      clawsDir: '/tmp/claws',
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      clawTopology: makeMockTopology('/tmp/claws'),
      clawTrackMap: new Map(),
      updateClawPanel: vi.fn(),
      requestRender: vi.fn(),
    });

    await manager.refreshAllClawStatus();

    expect(audit.write).not.toHaveBeenCalled();
  });

  it('reverse 3: topology.enumerate throws EACCES → emit REFRESH_CLAWS_FAILED', async () => {
    const audit = { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)};
    const err = Object.assign(new Error('Permission denied'), { code: 'EACCES' });
    const topologyThrowEacces: ClawTopology = {
      enumerate: vi.fn(() => { throw err; }),
      resolve: vi.fn((clawId: string) => ({ kind: 'local', clawDir: `/tmp/claws/${clawId}` })),
      read: vi.fn(),
      readJSON: vi.fn(),
    } as unknown as ClawTopology;

    const manager = createClawManager({
      fs: makeMockFs(),
      pm: { readPid: vi.fn().mockResolvedValue(null) },
      audit: audit as unknown as AuditLog,
      isMotion: true,
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      clawsDir: '/tmp/claws',
      clawTopology: topologyThrowEacces,
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
