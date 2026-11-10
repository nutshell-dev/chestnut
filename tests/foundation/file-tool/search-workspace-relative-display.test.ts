/**
 * Phase 776 — search workspace-relative display test
 * Phase 1422 — updated for unified segmented output (pattern / [Content matches]).
 *
 * Verify that search results show workspace-relative paths (no clawspace/ prefix)
 * for same-claw searches.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { readTool, searchTool } from '../../../src/foundation/file-tool/index.js';
import { ExecContextImpl } from '../../../src/foundation/tools/context.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { createClawPermissionChecker } from '../../../src/core/permissions/claw-permissions.js';
import { makeMockAudit } from '../../helpers/audit.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';

describe('search tool — workspace-relative display (phase 776 + 1422)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it('same-claw default path: displays foo.txt not clawspace/foo.txt', async () => {
    const clawDir = path.join(tempDir, 'claw');
    await fs.mkdir(path.join(clawDir, 'clawspace'), { recursive: true });
    await fs.writeFile(path.join(clawDir, 'clawspace', 'foo.txt'), 'needle in haystack');

    const mockFs = new NodeFileSystem({ baseDir: clawDir });
    const ctx = new ExecContextImpl({
      clawId: 'claw',
      clawDir,
      workspaceDir: path.join(clawDir, 'clawspace'),
      syncDir: path.join(clawDir, 'tasks/sync'),
      profile: 'full',
      fs: mockFs,
      permissionChecker: createClawPermissionChecker({ audit: makeMockAudit(), clawDir, strict: true, fs: new NodeFileSystem({ baseDir: clawDir }) }),
    });

    const result = await searchTool.execute({ text: 'needle' }, ctx);

    expect(result.success).toBe(true);
    expect(result.content).toContain('[Content matches]');
    expect(result.content).toContain('foo.txt');
    expect(result.content).toContain('1: needle in haystack');
    expect(result.content).not.toContain('clawspace/foo.txt');
  });

  it('same-claw path: "..": displays MEMORY.md not clawspace/MEMORY.md', async () => {
    const clawDir = path.join(tempDir, 'claw');
    await fs.mkdir(path.join(clawDir, 'clawspace'), { recursive: true });
    await fs.writeFile(path.join(clawDir, 'MEMORY.md'), 'needle memory');

    const mockFs = new NodeFileSystem({ baseDir: clawDir });
    const ctx = new ExecContextImpl({
      clawId: 'claw',
      clawDir,
      workspaceDir: path.join(clawDir, 'clawspace'),
      syncDir: path.join(clawDir, 'tasks/sync'),
      profile: 'full',
      fs: mockFs,
      permissionChecker: createClawPermissionChecker({ audit: makeMockAudit(), clawDir, strict: true, fs: new NodeFileSystem({ baseDir: clawDir }) }),
    });

    const result = await searchTool.execute({ text: 'needle', path: '..' }, ctx);

    expect(result.success).toBe(true);
    expect(result.content).toContain('MEMORY.md');
    expect(result.content).toContain('1: needle memory');
    expect(result.content).not.toContain('clawspace/');
  });

  it('overflow 提示：预览路径仍相对 workspace，artifact 路径可在 claw root 内被 read 取回', async () => {
    const clawDir = path.join(tempDir, 'claw');
    await fs.mkdir(path.join(clawDir, 'clawspace', 'sub'), { recursive: true });
    // 21 条命中（超过 20 条预览上限）→ 触发一次落盘
    await fs.writeFile(
      path.join(clawDir, 'clawspace', 'sub', 'many.txt'),
      Array.from({ length: 21 }, (_, i) => `needle-${String(i).padStart(3, '0')}`).join('\n'),
    );

    const mockFs = new NodeFileSystem({ baseDir: clawDir });
    const ctx = new ExecContextImpl({
      clawId: 'claw',
      clawDir,
      workspaceDir: path.join(clawDir, 'clawspace'),
      syncDir: path.join(clawDir, 'tasks/sync'),
      profile: 'full',
      fs: mockFs,
      permissionChecker: createClawPermissionChecker({ audit: makeMockAudit(), clawDir, strict: true, fs: new NodeFileSystem({ baseDir: clawDir }) }),
    });

    const result = await searchTool.execute({ text: 'needle' }, ctx);
    expect(result.success).toBe(true);
    // 预览路径语义不变：相对 workspace，不带 clawspace/ 前缀
    expect(result.content).toContain('sub/many.txt');
    expect(result.content).not.toContain('clawspace/sub/many.txt');
    // footer 给出的 artifact 位置相对 claw root
    expect(result.content).toContain('Full results saved at ../tasks/sync/search/');
    const hinted = /Full results saved at (\.\.\/tasks\/sync\/search\/[^\s)]+\.md)/.exec(result.content);
    expect(hinted).not.toBeNull();
    const artifactRel = hinted![1]!;
    // artifact 确实在 claw root 内（提示路径相对 workspace 解析）
    const artifactAbs = path.resolve(path.join(clawDir, 'clawspace'), artifactRel);
    expect(artifactAbs.startsWith(path.join(clawDir, 'tasks', 'sync', 'search'))).toBe(true);
    expect(await fs.readFile(artifactAbs, 'utf-8')).toContain('needle-000');

    // 提示路径交给 read（offset:1 limit:200）能取回首段
    const readBack = await readTool.execute({ path: artifactRel, offset: 1, limit: 200 }, ctx);
    expect(readBack.success).toBe(true);
    expect(readBack.content).toContain('[Content matches]');
    expect(readBack.content).toContain('needle-000');
  });

  it('same-claw nested subdir: displays sub/bar.txt not clawspace/sub/bar.txt', async () => {
    const clawDir = path.join(tempDir, 'claw');
    await fs.mkdir(path.join(clawDir, 'clawspace', 'sub'), { recursive: true });
    await fs.writeFile(path.join(clawDir, 'clawspace', 'sub', 'bar.txt'), 'needle nested');

    const mockFs = new NodeFileSystem({ baseDir: clawDir });
    const ctx = new ExecContextImpl({
      clawId: 'claw',
      clawDir,
      workspaceDir: path.join(clawDir, 'clawspace'),
      syncDir: path.join(clawDir, 'tasks/sync'),
      profile: 'full',
      fs: mockFs,
      permissionChecker: createClawPermissionChecker({ audit: makeMockAudit(), clawDir, strict: true, fs: new NodeFileSystem({ baseDir: clawDir }) }),
    });

    const result = await searchTool.execute({ text: 'needle' }, ctx);

    expect(result.success).toBe(true);
    expect(result.content).toContain('sub/bar.txt');
    expect(result.content).toContain('1: needle nested');
    expect(result.content).not.toContain('clawspace/sub/');
  });

  it('subagent workspace: displays foo.txt not tasks/subagents/<id>/foo.txt', async () => {
    const clawDir = path.join(tempDir, 'claw');
    const workspaceDir = path.join(clawDir, 'tasks', 'subagents', 'task-123');
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, 'foo.txt'), 'needle subagent');

    const mockFs = new NodeFileSystem({ baseDir: clawDir });
    const ctx = new ExecContextImpl({
      clawId: 'claw',
      clawDir,
      workspaceDir,
      syncDir: path.join(clawDir, 'tasks/sync'),
      profile: 'full',
      fs: mockFs,
      permissionChecker: createClawPermissionChecker({ audit: makeMockAudit(), clawDir, strict: true, fs: new NodeFileSystem({ baseDir: clawDir }) }),
    });

    const result = await searchTool.execute({ text: 'needle' }, ctx);

    expect(result.success).toBe(true);
    expect(result.content).toContain('foo.txt');
    expect(result.content).toContain('1: needle subagent');
    expect(result.content).not.toContain('tasks/subagents/task-123/foo.txt');
  });
});
