/**
 * invariants — mechanical merge of the following source files
 * (no assertion logic changed):
 *  - zod-strict-reject-cwd.test.ts
 *  - search-signal-observance.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { throwIfFileToolAborted } from '../../../src/foundation/file-tool/abort.js';
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
import { makeExecContext } from '../../helpers/exec-context.js';

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

describe('file-tool signal observance', () => {
  const cases = [
    { name: 'read', tool: readTool, args: { path: 'test.ts' } },
    { name: 'write', tool: writeTool, args: { path: 'test.ts', content: 'hello' } },
    { name: 'ls', tool: lsTool, args: { path: '.' } },
    { name: 'edit', tool: editTool, args: { path: 'test.ts', oldText: 'a', newText: 'b' } },
    { name: 'multi_edit', tool: multiEditTool, args: { path: 'test.ts', edits: [{ oldText: 'a', newText: 'b' }] } },
  ] as const;

  for (const testCase of cases) {
    it(`${testCase.name} rejects a pre-aborted signal before filesystem access`, async () => {
      const controller = new AbortController();
      controller.abort({ type: 'tool_timeout', ms: 1 });
      const fsNeverCalled = new Proxy({}, {
        get: (_target, property) => () => { throw new Error(`unexpected fs access: ${String(property)}`); },
      });
      const ctx = makeExecContext({ signal: controller.signal, fs: fsNeverCalled as never });

      await expect(testCase.tool.execute(testCase.args as Record<string, unknown>, ctx))
        .rejects.toMatchObject({ name: 'AbortError' });
    });
  }
});

describe('abort-reason-formatting', () => {
  it('circular abort reason falls back to String and still throws AbortError', () => {
    const controller = new AbortController();
    const reason: Record<string, unknown> = {};
    reason.self = reason;
    controller.abort(reason);

    let thrown: unknown;
    try {
      throwIfFileToolAborted(controller.signal);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).name).toBe('AbortError');
    expect((thrown as Error).message).toContain('File tool execution aborted:');
    expect((thrown as Error).message).toContain('[object Object]');
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
        workspaceDir: clawspaceDir,
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
        workspaceDir: clawspaceDir,
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
