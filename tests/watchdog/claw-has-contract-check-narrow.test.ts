/**
 * Phase 1215: clawHasContract isFileNotFound dual-code narrow
 *
 * 反向测试：
 * 1. FileNotFoundError (FileSystem abstract layer FS_NOT_FOUND) → 0 audit emit + continue
 * 2. raw ENOENT → 0 audit emit + continue
 * 3. EACCES → emit 1 次 CLAW_HAS_CONTRACT_CHECK_FAILED
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { clawHasContract } from '../../src/watchdog/watchdog-utils.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { FileNotFoundError } from '../../src/foundation/fs/types.js';
import { WATCHDOG_AUDIT_EVENTS } from '../../src/watchdog/audit-events.js';

describe('clawHasContract dual-code narrow (phase 1215)', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = path.join(tmpdir(), `wdutils-${randomUUID()}`);
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('reverse 1: FileNotFoundError → 0 audit emit + returns false', () => {
    const audit = { write: vi.fn() };
    const spy = vi.spyOn(NodeFileSystem.prototype, 'listSync').mockImplementation(() => {
      throw new FileNotFoundError('contract/paused');
    });

    const result = clawHasContract(testDir, audit as any);

    expect(result).toBe(false);
    expect(audit.write).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('reverse 2: raw ENOENT → 0 audit emit + returns false', () => {
    const audit = { write: vi.fn() };
    const err = Object.assign(new Error('no such file'), { code: 'ENOENT' });
    const spy = vi.spyOn(NodeFileSystem.prototype, 'listSync').mockImplementation(() => {
      throw err;
    });

    const result = clawHasContract(testDir, audit as any);

    expect(result).toBe(false);
    expect(audit.write).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('reverse 3: EACCES → emit CLAW_HAS_CONTRACT_CHECK_FAILED + returns false', () => {
    const audit = { write: vi.fn() };
    const err = Object.assign(new Error('Permission denied'), { code: 'EACCES' });
    const spy = vi.spyOn(NodeFileSystem.prototype, 'listSync').mockImplementation(() => {
      throw err;
    });

    const result = clawHasContract(testDir, audit as any);

    expect(result).toBe(false);
    expect(audit.write).toHaveBeenCalledTimes(2); // active + paused both throw
    expect(audit.write).toHaveBeenCalledWith(
      WATCHDOG_AUDIT_EVENTS.CLAW_HAS_CONTRACT_CHECK_FAILED,
      expect.stringContaining(testDir),
      expect.any(String),
      expect.stringContaining('Permission denied'),
    );

    spy.mockRestore();
  });
});
