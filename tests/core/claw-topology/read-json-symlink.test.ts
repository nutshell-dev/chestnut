/**
 * Phase 1813 Step B (CT-D6): ClawTopology read/readJSON canonical containment
 * 行为专测（真实 NodeFileSystem + 真实 symlink）。
 *
 * 锁定：词法 startsWith 只拦 '..' 穿越；clawspace 内 symlink 外逃必须经
 * realpath 双端比对拒绝（CrossClawReadError 'symlink escape'）——核心场景是
 * 指向 chestnutRoot 内其他 claw 的 symlink（NodeFileSystem baseDir 级 guard
 * 管不到 clawspace 粒度）；合法内部 symlink 可读；missing 文件 / ENOENT
 * ancestor / 非法 JSON 保持既有错误语义（不误报 escape）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { createClawTopology } from '../../../src/core/claw-topology/topology.js';
import { CrossClawReadError } from '../../../src/core/claw-topology/types.js';
import { makeClawId } from '../../../src/foundation/claw-identity/claw-id.js';
import type { ClawTopology } from '../../../src/core/claw-topology/types.js';

describe('phase 1813 (CT-D6): readJSON canonical symlink containment', () => {
  let tempDir: string;
  let fs: NodeFileSystem;
  let topology: ClawTopology;

  beforeEach(async () => {
    tempDir = await createTempDir();
    fs = new NodeFileSystem({ baseDir: tempDir });
    topology = createClawTopology({ fs, chestnutRoot: tempDir, motionDir: 'motion' });
    // 目标 claw 的 clawspace + 一份合法文件
    await fs.ensureDir('claws/beta/clawspace/inner');
    await fs.writeAtomic('claws/beta/clawspace/inner/ok.json', '{"ok":true}');
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it('合法内部 symlink（clawspace 内相对链接）→ readJSON 可读', async () => {
    // clawspace/link.json → inner/ok.json（同为 clawspace 内）
    symlinkSync('inner/ok.json', path.join(tempDir, 'claws/beta/clawspace/link.json'));

    const raw = await topology.readJSON('beta', 'link.json');
    expect(typeof raw).toBe('object');
    expect((raw as { ok?: unknown }).ok).toBe(true);
  });

  it('跨 claw symlink（chestnutRoot 内、本 clawspace 外）→ 拒绝 symlink escape（CT-D6 核心场景）', async () => {
    // beta/clawspace/stolen.json → claws/other/clawspace/private.json
    // —— 在 NodeFileSystem baseDir（chestnutRoot）内，baseDir 级 guard 不拦；
    // 必须靠 Topology 自己的 clawspace 粒度 canonical containment 拒绝。
    await fs.ensureDir('claws/other/clawspace');
    await fs.writeAtomic('claws/other/clawspace/private.json', '{"secret":42}');
    symlinkSync('../../other/clawspace/private.json', path.join(tempDir, 'claws/beta/clawspace/stolen.json'));

    await expect(topology.readJSON('beta', 'stolen.json')).rejects.toThrow(CrossClawReadError);
    await expect(topology.readJSON('beta', 'stolen.json')).rejects.toThrow(/symlink escape/);
    await expect(topology.read('beta', 'stolen.json')).rejects.toThrow(/symlink escape/);
  });

  it('外逃 symlink（指向 chestnutRoot 外）→ 拒绝（CrossClawReadError，防御纵深）', async () => {
    const outsideDir = await createTempDir();
    writeFileSync(path.join(outsideDir, 'secret.json'), '{"outside":true}');
    symlinkSync(path.join(outsideDir, 'secret.json'), path.join(tempDir, 'claws/beta/clawspace/evil.json'));

    await expect(topology.readJSON('beta', 'evil.json')).rejects.toThrow(CrossClawReadError);
  });

  it('ancestor 目录 symlink 外逃（clawspace/sub 是链接）→ 拒绝', async () => {
    const outsideDir = await createTempDir();
    writeFileSync(path.join(outsideDir, 'nested.json'), '{"nested":true}');
    symlinkSync(outsideDir, path.join(tempDir, 'claws/beta/clawspace/sub'));

    await expect(topology.readJSON('beta', 'sub/nested.json')).rejects.toThrow(CrossClawReadError);
  });

  it('missing 文件 → 既有 CrossClawReadError 缺文件语义，不误报 escape', async () => {
    const err = await topology.readJSON('beta', 'missing.json').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CrossClawReadError);
    expect(String(err)).not.toContain('symlink escape');
  });

  it('ENOENT ancestor（中间目录不存在）→ 缺文件语义，不误报 escape', async () => {
    const err = await topology.readJSON('beta', 'nosuchdir/file.json').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CrossClawReadError);
    expect(String(err)).not.toContain('symlink escape');
  });

  it('clawspace 目录本身不存在 → 缺文件语义，不误报 escape', async () => {
    await fs.ensureDir('claws/ghost'); // claw 存在但无 clawspace
    const err = await topology.readJSON('ghost', 'anything.json').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CrossClawReadError);
    expect(String(err)).not.toContain('symlink escape');
  });

  it('非法 JSON → 既有 JSON.parse SyntaxError 语义（不被 containment 改写）', async () => {
    await fs.writeAtomic('claws/beta/clawspace/bad.json', 'not-json{');
    await expect(topology.readJSON('beta', 'bad.json')).rejects.toThrow(SyntaxError);
  });
});
