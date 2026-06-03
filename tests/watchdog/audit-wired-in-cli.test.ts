import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';

import { getNamedSubrootDir, loadGlobalConfig } from '../../src/foundation/config/index.js';
import { buildTestGlobalConfig } from '../helpers/global-config.js';
import { setAuditWriter, getAuditWriter } from '../../src/watchdog/watchdog-context.js';
import { ensureAuditWired } from '../../src/watchdog/ensure.js';
import { WATCHDOG_AUDIT_EVENTS } from '../../src/watchdog/audit-events.js';
import { makeMockAudit } from '../helpers/audit.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';

const mockFindProcesses = vi.hoisted(() => vi.fn().mockReturnValue([]));
const mockKill = vi.hoisted(() => vi.fn());

vi.mock('../../src/foundation/config/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/config/index.js')>();
  return {
    ...actual,
    getNamedSubrootDir: vi.fn(),
    loadGlobalConfig: vi.fn(),
  };
});

vi.mock('../../src/foundation/process-manager/factories.js', () => ({
  createProcessManagerForCLI: vi.fn(() => ({
    findProcesses: mockFindProcesses,
  })),
}));

vi.mock('../../src/foundation/process-exec/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/process-exec/index.js')>();
  return {
    ...actual,
    kill: mockKill,
  };
});

describe('audit wired in CLI', () => {
  let tmpDir: string;
  let chestnutDir: string;
  const originalConsoleError = console.error;
  const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `wd-audit-wire-${randomUUID()}`);
    chestnutDir = path.join(tmpDir, '.chestnut');
    fs.mkdirSync(chestnutDir, { recursive: true });
    vi.mocked(getNamedSubrootDir).mockReturnValue(path.join(chestnutDir, 'motion'));
    vi.mocked(loadGlobalConfig).mockReturnValue(buildTestGlobalConfig());

    setAuditWriter(null);

    mockFindProcesses.mockReturnValue([]);
    mockKill.mockImplementation(() => {});
    console.error = vi.fn();
  });

  afterEach(() => {
    setAuditWriter(null);
    console.error = originalConsoleError;
    vi.clearAllMocks();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('sweepOrphanWatchdogs auto-wires audit when not previously set and writes ORPHAN_SWEEP_KILLED', async () => {
    const { sweepOrphanWatchdogs } = await import('../../src/watchdog/orphan-sweep.js');

    mockFindProcesses.mockReturnValue([2000]);

    const killed = await sweepOrphanWatchdogs(fsFactory, { excludePid: null });

    expect(killed).toEqual([2000]);
    expect(getAuditWriter()).not.toBeNull();

    const auditPath = path.join(chestnutDir, 'audit.tsv');
    expect(fs.existsSync(auditPath)).toBe(true);
    const content = fs.readFileSync(auditPath, 'utf8');
    expect(content).toContain(WATCHDOG_AUDIT_EVENTS.ORPHAN_SWEEP_KILLED);
  });

  it('daemon process: existing audit writer is preserved by ensureAuditWired', () => {
    const mockWriter = makeMockAudit();
    setAuditWriter(mockWriter);

    ensureAuditWired();

    expect(getAuditWriter()).toBe(mockWriter);
    expect(mockWriter.write).not.toHaveBeenCalled();
  });

  it('ensureAuditWired fail-soft when getChestnutFs throws, preserving null audit writer', () => {
    vi.mocked(getNamedSubrootDir).mockImplementation(() => {
      throw new Error('fs unreachable');
    });

    expect(() => ensureAuditWired()).not.toThrow();
    expect(getAuditWriter()).toBeNull();
    expect(console.error).toHaveBeenCalledWith(
      'Failed to wire watchdog audit in CLI:',
      expect.any(Error),
    );
  });
});
