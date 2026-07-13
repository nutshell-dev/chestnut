import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { clawHasContract } from '../../src/watchdog/watchdog-utils.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { WATCHDOG_AUDIT_EVENTS } from '../../src/watchdog/audit-events.js';
import { makeMockAudit } from '../helpers/audit.js';

describe('clawHasContract silent X (phase 994 A.2)', () => {
  let testDir: string;
  const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

  beforeEach(() => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    testDir = path.join(tmpdir(), `wdutils-${randomUUID()}`);
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('non-ENOENT error emits audit and returns false', () => {
    const audit = makeMockAudit();
    const err = Object.assign(new Error('Permission denied'), { code: 'EACCES' });
    const spy = vi.spyOn(NodeFileSystem.prototype, 'listSync').mockImplementation(() => {
      throw err;
    });

    const result = clawHasContract(testDir, fsFactory, audit as any);

    expect(result).toBe(false);
    expect(audit.write).toHaveBeenCalledWith(
      WATCHDOG_AUDIT_EVENTS.CLAW_HAS_CONTRACT_CHECK_FAILED,
      expect.stringContaining(testDir),
      expect.any(String),
      expect.stringContaining('Permission denied'),
    );

    spy.mockRestore();
  });

  it('ENOENT error does not emit audit and returns false', () => {
    const audit = makeMockAudit();
    const err = Object.assign(new Error('no such file'), { code: 'ENOENT' });
    const spy = vi.spyOn(NodeFileSystem.prototype, 'listSync').mockImplementation(() => {
      throw err;
    });

    const result = clawHasContract(testDir, fsFactory, audit as any);

    expect(result).toBe(false);
    expect(audit.write).not.toHaveBeenCalled();

    spy.mockRestore();
  });
});
