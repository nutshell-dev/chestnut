/**
 * Phase 1036 — search.ts walkNative signal observance reverse test
 *
 * Verify that an aborted AbortSignal interrupts walkNative recursion
 * and causes graceful return (0 matches) instead of continuing the search.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { searchTool } from '../../../src/foundation/file-tool/index.js';
import { ExecContextImpl } from '../../../src/foundation/tools/context.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { createClawPermissionChecker } from '../../../src/core/permissions/claw-permissions.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';

describe('phase 1036: search.ts walkNative signal observance (F-4)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it('walkNative finds matches without abort signal', async () => {
    const mainClawDir = path.join(tempDir, 'main-claw');
    const otherClawDir = path.join(tempDir, 'claws', 'other-claw', 'clawspace');
    await fs.mkdir(otherClawDir, { recursive: true });
    await fs.writeFile(path.join(otherClawDir, 'note.txt'), 'needle in haystack');

    const mockFs = new NodeFileSystem({ baseDir: mainClawDir });
    const ctx = new ExecContextImpl({
      clawId: 'main-claw',
      clawDir: mainClawDir,
      syncDir: path.join(mainClawDir, 'tasks/sync'),
      profile: 'full',
      fs: mockFs,
      permissionChecker: createClawPermissionChecker({ clawDir: mainClawDir, strict: true }),
    });

    const result = await searchTool.execute(
      { query: 'needle', path: 'clawspace', claw: 'other-claw' },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.content).toContain('needle');
  });

  it('aborted signal interrupts walkNative recursion (反向 1)', async () => {
    const mainClawDir = path.join(tempDir, 'main-claw');
    const otherClawDir = path.join(tempDir, 'claws', 'other-claw', 'clawspace');
    await fs.mkdir(otherClawDir, { recursive: true });
    await fs.writeFile(path.join(otherClawDir, 'note.txt'), 'needle in haystack');

    const controller = new AbortController();
    controller.abort();

    const mockFs = new NodeFileSystem({ baseDir: mainClawDir });
    const ctx = new ExecContextImpl({
      clawId: 'main-claw',
      clawDir: mainClawDir,
      syncDir: path.join(mainClawDir, 'tasks/sync'),
      profile: 'full',
      fs: mockFs,
      signal: controller.signal,
      permissionChecker: createClawPermissionChecker({ clawDir: mainClawDir, strict: true }),
    });

    const result = await searchTool.execute(
      { query: 'needle', path: 'clawspace', claw: 'other-claw' },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.content).toBe('未找到包含 "needle" 的内容');
  });
});
