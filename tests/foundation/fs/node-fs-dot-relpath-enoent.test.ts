import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';

describe('phase 1395: resolveAndCheck dot-relpath ENOENT false-positive fix', () => {
  let tempDir: string;
  beforeEach(() => { tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase1395-')); });
  afterEach(() => { fs.rmSync(tempDir, { recursive: true, force: true }); });

  it('baseDir 不存在 + parent 存在 + relPath="." 不再 throw (regression fix)', () => {
    const baseDir = path.join(tempDir, 'parent', 'not-yet-existing');
    fs.mkdirSync(path.join(tempDir, 'parent'), { recursive: true });
    // baseDir 不存在、parent 存在
    const sys = new NodeFileSystem({ baseDir });
    expect(() => sys.existsSync('.')).not.toThrow();
    expect(sys.existsSync('.')).toBe(false);
  });

  it('baseDir 不存在 + parent 存在 + ensureDir(".") 成功创建 (skill install copyDir case)', async () => {
    const baseDir = path.join(tempDir, 'parent', 'new-skill-dest');
    fs.mkdirSync(path.join(tempDir, 'parent'), { recursive: true });
    const sys = new NodeFileSystem({ baseDir });
    await sys.ensureDir('.');
    expect(fs.existsSync(baseDir)).toBe(true);
  });

  it('baseDir 存在 + relPath="." happy path 不破', () => {
    const baseDir = path.join(tempDir, 'existing');
    fs.mkdirSync(baseDir, { recursive: true });
    const sys = new NodeFileSystem({ baseDir });
    expect(sys.existsSync('.')).toBe(true);
  });

  it('真 symlink-in-relPath escape 仍 reject (security check 保留)', () => {
    const baseDir = path.join(tempDir, 'base');
    const outsideDir = path.join(tempDir, 'outside');
    fs.mkdirSync(baseDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    // 创建 symlink baseDir/link → outsideDir
    fs.symlinkSync(outsideDir, path.join(baseDir, 'link'));
    const sys = new NodeFileSystem({ baseDir });
    // relPath = "link/x" 解析后 realpath 在 outsideDir、应 reject
    expect(() => sys.existsSync('link/x')).toThrow(/Symlink traversal detected/);
  });

  it('反向 — mirror task acfddf0f skill install 场景不再假阳性', async () => {
    const clawDir = path.join(tempDir, '.chestnut', 'claws', 'test-claw');
    fs.mkdirSync(path.join(clawDir, 'skills'), { recursive: true });
    // skillDest 不存在、skills/ parent 存在
    const skillDest = path.join(clawDir, 'skills', 'new-skill');
    const sys = new NodeFileSystem({ baseDir: skillDest });
    await expect(sys.ensureDir('.')).resolves.not.toThrow();
  });
});
