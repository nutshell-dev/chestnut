import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { createClawPermissionChecker } from '../../../src/core/permissions/claw-permissions.js';
import { PathNotInClawSpaceError } from '../../../src/foundation/errors.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';

describe('claw-permissions symlink escape (phase 951)', () => {
  let root: string;
  let clawDir: string;
  let outsideDir: string;
  let symlinkInsideClaw: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(tmpdir(), 'claw-perm-test-'));
    clawDir = path.join(root, 'claw-a');
    outsideDir = path.join(root, 'outside');
    fs.mkdirSync(clawDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'hidden');
    symlinkInsideClaw = path.join(clawDir, 'escape-link');
    fs.symlinkSync(outsideDir, symlinkInsideClaw, 'dir');
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const makeChecker = () => createClawPermissionChecker({ clawDir, fs: new NodeFileSystem({ baseDir: clawDir }) });

  it.skipIf(process.platform === 'win32')(
    'rejects symlink-via-escape (readAccess)',
    () => {
      const checker = makeChecker();
      const escapedPath = path.join(symlinkInsideClaw, 'secret.txt');
      expect(() => checker.checkRead(escapedPath)).toThrow(PathNotInClawSpaceError);
    }
  );

  it.skipIf(process.platform === 'win32')(
    'rejects symlink-via-escape (writeAccess)',
    () => {
      const checker = makeChecker();
      const escapedPath = path.join(symlinkInsideClaw, 'secret.txt');
      expect(() => checker.checkWrite(escapedPath)).toThrow(PathNotInClawSpaceError);
    }
  );

  it('happy path no-symlink unchanged (writable claw subdir)', () => {
    const checker = makeChecker();
    const ok = path.join(clawDir, 'memory', 'data.md');
    expect(() => checker.checkWrite(ok)).not.toThrow();
    expect(() => checker.checkRead(ok)).not.toThrow();
  });

  it('non-existent target inside claw still resolves via dirname realpath fallback', () => {
    const checker = makeChecker();
    const newFile = path.join(clawDir, 'memory', 'new-not-yet.md');
    expect(() => checker.checkWrite(newFile)).not.toThrow();
    expect(() => checker.checkRead(newFile)).not.toThrow();
  });
});
