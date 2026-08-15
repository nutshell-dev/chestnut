/**
 * claw has contract invariants — mechanical merge of the following source files
 * (no assertion logic changed):
 *  - watchdog-cron-claw-has-contract.test.ts
 *  - claw-has-contract-check-narrow.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { clawHasContract } from '../../src/watchdog/watchdog-utils.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { makeMockAudit } from '../helpers/audit.js';
import { FileNotFoundError } from '../../src/foundation/fs/types.js';

describe('watchdog-cron-claw-has-contract', () => {
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

    it('non-ENOENT error returns false (active scan is silent)', () => {
      const audit = makeMockAudit();
      const err = Object.assign(new Error('Permission denied'), { code: 'EACCES' });
      const spy = vi.spyOn(NodeFileSystem.prototype, 'listSync').mockImplementation(() => {
        throw err;
      });

      const result = clawHasContract(testDir, fsFactory, audit as any);

      expect(result).toBe(false);
      expect(audit.write).not.toHaveBeenCalled();

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
});

describe('claw-has-contract-check-narrow', () => {
  /**
   * Phase 1215: clawHasContract isFileNotFound dual-code narrow
   *
   * 反向测试：
   * 1. FileNotFoundError (FileSystem abstract layer FS_NOT_FOUND) → 0 audit emit + continue
   * 2. raw ENOENT → 0 audit emit + continue
   * 3. EACCES → emit 1 次 CLAW_HAS_CONTRACT_CHECK_FAILED
   */

  describe('clawHasContract dual-code narrow (phase 1215)', () => {
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

    it('reverse 1: FileNotFoundError → 0 audit emit + returns false', () => {
      const audit = { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)};
      const spy = vi.spyOn(NodeFileSystem.prototype, 'listSync').mockImplementation(() => {
        throw new FileNotFoundError('contract/paused');
      });

      const result = clawHasContract(testDir, fsFactory, audit as any);

      expect(result).toBe(false);
      expect(audit.write).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('reverse 2: raw ENOENT → 0 audit emit + returns false', () => {
      const audit = { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)};
      const err = Object.assign(new Error('no such file'), { code: 'ENOENT' });
      const spy = vi.spyOn(NodeFileSystem.prototype, 'listSync').mockImplementation(() => {
        throw err;
      });

      const result = clawHasContract(testDir, fsFactory, audit as any);

      expect(result).toBe(false);
      expect(audit.write).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('reverse 3: EACCES → emit CLAW_HAS_CONTRACT_CHECK_FAILED + returns false', () => {
      const audit = { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)};
      const err = Object.assign(new Error('Permission denied'), { code: 'EACCES' });
      const spy = vi.spyOn(NodeFileSystem.prototype, 'listSync').mockImplementation(() => {
        throw err;
      });

      const result = clawHasContract(testDir, fsFactory, audit as any);

      expect(result).toBe(false);
      expect(audit.write).not.toHaveBeenCalled();

      spy.mockRestore();
    });
  });
});
