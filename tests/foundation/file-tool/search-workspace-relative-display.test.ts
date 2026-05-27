/**
 * Phase 776 — search workspace-relative display test
 *
 * Verify that search results show workspace-relative paths (no clawspace/ prefix)
 * for same-claw searches, while cross-claw display semantics remain unchanged.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { searchTool } from '../../../src/foundation/file-tool/index.js';
import { ExecContextImpl } from '../../../src/foundation/tools/context.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { createClawPermissionChecker } from '../../../src/core/permissions/claw-permissions.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';

describe('search tool — workspace-relative display (phase 776)', () => {
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
      syncDir: path.join(clawDir, 'tasks/sync'),
      profile: 'full',
      fs: mockFs,
      permissionChecker: createClawPermissionChecker({ clawDir, strict: true }),
    });

    const result = await searchTool.execute({ query: 'needle' }, ctx);

    expect(result.success).toBe(true);
    expect(result.content).toContain('foo.txt:1:');
    expect(result.content).not.toContain('clawspace/foo.txt:');
  });

  it('same-claw cwd: "..": displays MEMORY.md not clawspace/MEMORY.md', async () => {
    const clawDir = path.join(tempDir, 'claw');
    await fs.mkdir(path.join(clawDir, 'clawspace'), { recursive: true });
    await fs.writeFile(path.join(clawDir, 'MEMORY.md'), 'needle memory');

    const mockFs = new NodeFileSystem({ baseDir: clawDir });
    const ctx = new ExecContextImpl({
      clawId: 'claw',
      clawDir,
      syncDir: path.join(clawDir, 'tasks/sync'),
      profile: 'full',
      fs: mockFs,
      permissionChecker: createClawPermissionChecker({ clawDir, strict: true }),
    });

    const result = await searchTool.execute({ query: 'needle', cwd: '..' }, ctx);

    expect(result.success).toBe(true);
    expect(result.content).toContain('MEMORY.md:1:');
    expect(result.content).not.toContain('clawspace/');
  });

  it('same-claw nested subdir: displays sub/bar.txt not clawspace/sub/bar.txt', async () => {
    const clawDir = path.join(tempDir, 'claw');
    await fs.mkdir(path.join(clawDir, 'clawspace', 'sub'), { recursive: true });
    await fs.writeFile(path.join(clawDir, 'clawspace', 'sub', 'bar.txt'), 'needle nested');

    const mockFs = new NodeFileSystem({ baseDir: clawDir });
    const ctx = new ExecContextImpl({
      clawId: 'claw',
      clawDir,
      syncDir: path.join(clawDir, 'tasks/sync'),
      profile: 'full',
      fs: mockFs,
      permissionChecker: createClawPermissionChecker({ clawDir, strict: true }),
    });

    const result = await searchTool.execute({ query: 'needle' }, ctx);

    expect(result.success).toBe(true);
    expect(result.content).toContain('sub/bar.txt:1:');
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
      permissionChecker: createClawPermissionChecker({ clawDir, strict: true }),
    });

    const result = await searchTool.execute({ query: 'needle' }, ctx);

    expect(result.success).toBe(true);
    expect(result.content).toContain('foo.txt:1:');
    expect(result.content).not.toContain('tasks/subagents/task-123/foo.txt:');
  });

  it('cross-claw search: keeps target claw-relative display (unchanged)', async () => {
    const mainClawDir = path.join(tempDir, 'main-claw');
    await fs.mkdir(mainClawDir, { recursive: true });
    const otherClawDir = path.join(tempDir, 'claws', 'other-claw', 'clawspace');
    await fs.mkdir(otherClawDir, { recursive: true });
    await fs.writeFile(path.join(otherClawDir, 'note.txt'), 'cross-claw needle');

    const mockFs = new NodeFileSystem({ baseDir: mainClawDir });
    const ctx = new ExecContextImpl({
      clawId: 'main-claw',
      clawDir: mainClawDir,
      syncDir: path.join(mainClawDir, 'tasks/sync'),
      profile: 'full',
      fs: mockFs,
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
      permissionChecker: createClawPermissionChecker({ clawDir: mainClawDir, strict: true }),
    });

    const result = await searchTool.execute({ query: 'needle', path: 'clawspace', claw: 'other-claw' }, ctx);

    expect(result.success).toBe(true);
    // cross-claw walkNative returns relPath relative to target claw root
    expect(result.content).toContain('note.txt:');
    expect(result.content).toContain('cross-claw needle');
  });
});
