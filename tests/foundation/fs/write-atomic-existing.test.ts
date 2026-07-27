/**
 * Phase 1201 Step E: NodeFileSystem.writeAtomicExisting semantics.
 *
 * existing-parent atomic write 协议：
 * - parent 存在 → temp 同目录写入、fsync、rename target（与 writeAtomic 相同）；
 * - parent 不存在 → FileNotFoundError，且不创建 parent 或任何 ancestor；
 * - temp 随目录 rename 移动时旧路径失败，不复活旧 parent（竞态语义由
 *   contract 层 ghost race test 端到端覆盖）。
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'path';
import * as fsp from 'fs/promises';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { FileNotFoundError, isFileNotFound } from '../../../src/foundation/fs/index.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';

const cleanups: string[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanupTempDir(cleanups.pop()!);
});

async function setup() {
  const tempDir = await createTempDir('phase1201-wae-');
  cleanups.push(tempDir);
  const fs = new NodeFileSystem({ baseDir: tempDir });
  return { tempDir, fs };
}

describe('NodeFileSystem.writeAtomicExisting (phase 1201 step E)', () => {
  it('parent 存在：写入内容与 writeAtomic 等价（roundtrip）', async () => {
    const { tempDir, fs } = await setup();
    await fsp.mkdir(path.join(tempDir, 'parent'), { recursive: true });

    await fs.writeAtomicExisting('parent/file.json', '{"a":1}');

    expect(await fs.read('parent/file.json')).toBe('{"a":1}');
    // 无 temp 残留。
    const entries = await fsp.readdir(path.join(tempDir, 'parent'));
    expect(entries.filter(e => e.startsWith('.tmp_'))).toEqual([]);
  });

  it('parent 存在：replace 既有文件', async () => {
    const { tempDir, fs } = await setup();
    await fsp.mkdir(path.join(tempDir, 'parent'), { recursive: true });
    await fsp.writeFile(path.join(tempDir, 'parent', 'file.json'), 'old', 'utf-8');

    await fs.writeAtomicExisting('parent/file.json', 'new');

    expect(await fs.read('parent/file.json')).toBe('new');
  });

  it('parent 不存在：FileNotFoundError 且不创建 parent/ancestor、无 temp 残留', async () => {
    const { tempDir, fs } = await setup();

    let caught: unknown;
    try {
      await fs.writeAtomicExisting('missing/child/file.json', 'x');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(FileNotFoundError);
    expect(isFileNotFound(caught)).toBe(true);
    // 不创建 parent 或任何 ancestor。
    await expect(fsp.access(path.join(tempDir, 'missing'))).rejects.toThrow();
    // baseDir 下无 temp ghost。
    const entries = await fsp.readdir(tempDir);
    expect(entries.filter(e => e.startsWith('.tmp_'))).toEqual([]);
  });

  it('parent 在 temp 创建前被 rename 走：失败且不复活旧 parent（确定性模拟 terminal rename 先胜出）', async () => {
    const { tempDir, fs } = await setup();
    // 模拟 contract 场景：active/<id> 存在，terminal rename 将其移走后再写。
    const activeDir = path.join(tempDir, 'active', 'c1');
    await fsp.mkdir(activeDir, { recursive: true });
    await fsp.mkdir(path.join(tempDir, 'archive'), { recursive: true });
    await fsp.rename(activeDir, path.join(tempDir, 'archive', 'c1'));

    let caught: unknown;
    try {
      await fs.writeAtomicExisting('active/c1/progress.json', '{}');
    } catch (err) {
      caught = err;
    }

    expect(isFileNotFound(caught)).toBe(true);
    // 旧 active/c1 未被 ghost-recreate。
    await expect(fsp.access(activeDir)).rejects.toThrow();
    // active/ 下无 temp ghost。
    const entries = await fsp.readdir(path.join(tempDir, 'active'));
    expect(entries.filter(e => e.startsWith('.tmp_'))).toEqual([]);
  });
});
