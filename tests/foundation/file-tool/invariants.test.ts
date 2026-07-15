/**
 * invariants — mechanical merge of the following source files
 * (no assertion logic changed):
 *  - zod-strict-reject-cwd.test.ts
 *  - search-signal-observance.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readTool } from '../../../src/foundation/file-tool/read.js';
import { writeTool } from '../../../src/foundation/file-tool/write.js';
import { lsTool } from '../../../src/foundation/file-tool/ls.js';
import { editTool } from '../../../src/foundation/file-tool/edit.js';
import { multiEditTool } from '../../../src/foundation/file-tool/multi_edit.js';
import { searchTool } from '../../../src/foundation/file-tool/search.js';
import * as path from 'path';
import { promises as fs } from 'fs';
import { ExecContextImpl } from '../../../src/foundation/tools/context.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { createClawPermissionChecker } from '../../../src/core/permissions/claw-permissions.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';

describe('zod-strict-reject-cwd', () => {
  describe('file-tool Zod strict reject cwd (phase 305 cluster G #9 A 类)', () => {
    const TOOLS = [
      { name: 'read', tool: readTool, validArgs: { path: 'test.ts' } },
      { name: 'write', tool: writeTool, validArgs: { path: 'test.ts', content: 'hello' } },
      { name: 'ls', tool: lsTool, validArgs: { path: '.' } },
      { name: 'edit', tool: editTool, validArgs: { path: 'test.ts', oldText: 'a', newText: 'b' } },
      { name: 'multi_edit', tool: multiEditTool, validArgs: { path: 'test.ts', edits: [] } },
      { name: 'search', tool: searchTool, validArgs: { text: 'hello', path: '.' } },
    ];

    for (const { name, tool, validArgs } of TOOLS) {
      it(`${name}: schema 不含 cwd field (Zod SoT)`, () => {
        const schema = tool.schema as { properties?: Record<string, unknown> };
        expect(schema.properties).not.toHaveProperty('cwd');
      });

      it(`${name}: LLM input 含 cwd → execute returns validation failure (Zod strict runtime)`, async () => {
        const mockCtx = {} as any;
        const result = await tool.execute({ ...validArgs, cwd: '/tmp/illegal' }, mockCtx);
        expect(result.success).toBe(false);
        expect(result.content).toMatch(/validation failed|unrecognized key/i);
      });
    }
  });
});

describe('search-signal-observance', () => {
  /**
   * Phase 1036 — search.ts walk signal observance reverse test
   *
   * Verify that an aborted AbortSignal interrupts walk recursion
   * and causes graceful return (0 matches) instead of continuing the search.
   */

  describe('phase 1036: search.ts walk signal observance (F-4)', () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await createTempDir();
    });

    afterEach(async () => {
      await cleanupTempDir(tempDir);
    });

    it('walk finds matches without abort signal', async () => {
      const clawDir = path.join(tempDir, 'claw');
      const clawspaceDir = path.join(clawDir, 'clawspace');
      await fs.mkdir(clawspaceDir, { recursive: true });
      await fs.writeFile(path.join(clawspaceDir, 'note.txt'), 'needle in haystack');

      const mockFs = new NodeFileSystem({ baseDir: clawDir });
      const ctx = new ExecContextImpl({
        clawId: 'claw',
        clawDir,
        syncDir: path.join(clawDir, 'tasks/sync'),
        profile: 'full',
        fs: mockFs,
        permissionChecker: createClawPermissionChecker({ clawDir, strict: true }),
      });

      const result = await searchTool.execute(
        { text: 'needle', path: 'clawspace' },
        ctx,
      );

      expect(result.success).toBe(true);
      expect(result.content).toContain('needle');
    });

    it('aborted signal interrupts walk recursion (反向 1)', async () => {
      const clawDir = path.join(tempDir, 'claw');
      const clawspaceDir = path.join(clawDir, 'clawspace');
      await fs.mkdir(clawspaceDir, { recursive: true });
      await fs.writeFile(path.join(clawspaceDir, 'note.txt'), 'needle in haystack');

      const controller = new AbortController();
      controller.abort();

      const mockFs = new NodeFileSystem({ baseDir: clawDir });
      const ctx = new ExecContextImpl({
        clawId: 'claw',
        clawDir,
        syncDir: path.join(clawDir, 'tasks/sync'),
        profile: 'full',
        fs: mockFs,
        signal: controller.signal,
        permissionChecker: createClawPermissionChecker({ clawDir, strict: true }),
      });

      const result = await searchTool.execute(
        { text: 'needle', path: 'clawspace' },
        ctx,
      );

      expect(result.success).toBe(true);
      expect(result.content).toBe('No matches for "needle".');
    });
  });
});
