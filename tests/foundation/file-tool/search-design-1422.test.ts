/**
 * Phase 1422 — search design completion test
 *
 * Q1 pattern / Q2 unified filename + content / Q3 skip classification /
 * Q4 binary detect + default exclude / Q5 English output /
 * Q6 全扫 + overflow persist + preview 20 / Q7 cross-claw [clawId] prefix
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { searchTool } from '../../../src/foundation/file-tool/index.js';
import { ExecContextImpl } from '../../../src/foundation/tools/context.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { createClawPermissionChecker } from '../../../src/core/permissions/claw-permissions.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { SEARCH_PREVIEW_LIMIT } from '../../../src/foundation/file-tool/constants.js';

function makeCtx(clawDir: string) {
  const mockFs = new NodeFileSystem({ baseDir: clawDir });
  return new ExecContextImpl({
    clawId: 'claw',
    clawDir,
    syncDir: path.join(clawDir, 'tasks/sync'),
    profile: 'full',
    fs: mockFs,
    permissionChecker: createClawPermissionChecker({ clawDir, strict: true }),
  });
}

describe('phase 1422: search design completion', () => {
  let tempDir: string;
  let clawDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    clawDir = path.join(tempDir, 'claw');
    await fs.mkdir(path.join(clawDir, 'clawspace'), { recursive: true });
    await fs.mkdir(path.join(clawDir, 'tasks/sync/search'), { recursive: true });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it('Q1: rejects missing pattern arg with error', async () => {
    const ctx = makeCtx(clawDir);
    const result = await searchTool.execute({}, ctx);
    expect(result.success).toBe(false);
    expect(result.content).toContain('pattern');
  });

  it('Q1: rejects empty pattern', async () => {
    const ctx = makeCtx(clawDir);
    const result = await searchTool.execute({ pattern: '' }, ctx);
    expect(result.success).toBe(false);
  });

  it('Q1: rejects pattern longer than 1024 chars', async () => {
    const ctx = makeCtx(clawDir);
    const result = await searchTool.execute({ pattern: 'x'.repeat(1025) }, ctx);
    expect(result.success).toBe(false);
    expect(result.content).toContain('1024');
  });

  it('Q2: unified search returns both [Filename matches] and [Content matches]', async () => {
    await fs.writeFile(path.join(clawDir, 'clawspace', 'foo-config.txt'), 'unrelated\nmiddle line\nfoo somewhere here');
    await fs.writeFile(path.join(clawDir, 'clawspace', 'other.txt'), 'nothing relevant');
    const ctx = makeCtx(clawDir);
    const result = await searchTool.execute({ pattern: 'foo' }, ctx);
    expect(result.success).toBe(true);
    expect(result.content).toContain('[Filename matches]');
    expect(result.content).toContain('foo-config.txt');
    expect(result.content).toContain('[Content matches]');
    expect(result.content).toContain('3: foo somewhere here');
  });

  it('Q3 caseSensitive default false: matches FOO with pattern foo', async () => {
    await fs.writeFile(path.join(clawDir, 'clawspace', 'a.txt'), 'FOO line here');
    const ctx = makeCtx(clawDir);
    const result = await searchTool.execute({ pattern: 'foo' }, ctx);
    expect(result.success).toBe(true);
    expect(result.content).toContain('FOO line here');
  });

  it('Q3 caseSensitive true: does NOT match FOO with pattern foo', async () => {
    await fs.writeFile(path.join(clawDir, 'clawspace', 'a.txt'), 'FOO line here');
    const ctx = makeCtx(clawDir);
    const result = await searchTool.execute({ pattern: 'foo', caseSensitive: true }, ctx);
    expect(result.success).toBe(true);
    expect(result.content).toBe('No matches for "foo".');
  });

  it('Q3 skip classification: binary file appears in [Skipped] with reason binary', async () => {
    const bin = Buffer.from([0x68, 0x69, 0x00, 0x00, 0x77, 0x6f]); // "hi\0\0wo"
    await fs.writeFile(path.join(clawDir, 'clawspace', 'logo.bin'), bin);
    await fs.writeFile(path.join(clawDir, 'clawspace', 'normal.txt'), 'has hi inside');
    const ctx = makeCtx(clawDir);
    const result = await searchTool.execute({ pattern: 'hi' }, ctx);
    expect(result.success).toBe(true);
    expect(result.content).toContain('[Skipped]');
    expect(result.content).toContain('logo.bin (binary)');
    expect(result.content).toContain('binary=1');
    expect(result.content).toContain('normal.txt');
  });

  it('Q4 default exclude: node_modules content is not searched', async () => {
    await fs.mkdir(path.join(clawDir, 'clawspace', 'node_modules', 'pkg'), { recursive: true });
    await fs.writeFile(path.join(clawDir, 'clawspace', 'node_modules', 'pkg', 'index.js'), 'needle in module');
    await fs.writeFile(path.join(clawDir, 'clawspace', 'src.txt'), 'needle in src');
    const ctx = makeCtx(clawDir);
    const result = await searchTool.execute({ pattern: 'needle' }, ctx);
    expect(result.success).toBe(true);
    expect(result.content).toContain('needle in src');
    expect(result.content).not.toContain('needle in module');
  });

  it('Q4 explicit path overrides default exclude', async () => {
    await fs.mkdir(path.join(clawDir, 'clawspace', 'node_modules', 'pkg'), { recursive: true });
    await fs.writeFile(path.join(clawDir, 'clawspace', 'node_modules', 'pkg', 'index.js'), 'needle in module');
    const ctx = makeCtx(clawDir);
    const result = await searchTool.execute({ pattern: 'needle', path: 'node_modules' }, ctx);
    expect(result.success).toBe(true);
    expect(result.content).toContain('needle in module');
  });

  it('Q5: zero matches uses English message', async () => {
    await fs.writeFile(path.join(clawDir, 'clawspace', 'a.txt'), 'nothing here');
    const ctx = makeCtx(clawDir);
    const result = await searchTool.execute({ pattern: 'absent' }, ctx);
    expect(result.success).toBe(true);
    expect(result.content).toBe('No matches for "absent".');
  });

  it('Q6: matches <= preview limit returned full, no overflow file written', async () => {
    const lines = Array.from({ length: SEARCH_PREVIEW_LIMIT - 1 }, () => 'needle line').join('\n');
    await fs.writeFile(path.join(clawDir, 'clawspace', 'a.txt'), lines);
    const ctx = makeCtx(clawDir);
    const result = await searchTool.execute({ pattern: 'needle' }, ctx);
    expect(result.success).toBe(true);
    expect(result.content).not.toContain('Showing 1-');
    expect(result.content).not.toContain('Full results saved at');
    const overflowDir = path.join(clawDir, 'tasks/sync/search');
    const files = await fs.readdir(overflowDir);
    expect(files.length).toBe(0);
  });

  it('Q6: matches > preview limit triggers overflow persist + preview footer', async () => {
    const lines = Array.from({ length: SEARCH_PREVIEW_LIMIT + 10 }, () => 'needle line').join('\n');
    await fs.writeFile(path.join(clawDir, 'clawspace', 'a.txt'), lines);
    const ctx = makeCtx(clawDir);
    const result = await searchTool.execute({ pattern: 'needle' }, ctx);
    expect(result.success).toBe(true);
    expect(result.content).toContain(`Showing 1-${SEARCH_PREVIEW_LIMIT} of ${SEARCH_PREVIEW_LIMIT + 10} matches.`);
    // workspace-relative path: workspace defaults to clawspace/, so persisted file at
    // clawDir/tasks/sync/search/ shows as ../tasks/sync/search/ (escapes clawspace).
    expect(result.content).toMatch(/Full results saved at \.\.\/tasks\/sync\/search\//);
    expect(result.content).toMatch(/read\(\{ "path": "\.\.\/tasks\/sync\/search\/.+\.md", "offset": 21, "limit": 200 \}\)/);
    const overflowDir = path.join(clawDir, 'tasks/sync/search');
    const files = await fs.readdir(overflowDir);
    expect(files.length).toBe(1);
    const persisted = await fs.readFile(path.join(overflowDir, files[0]), 'utf-8');
    expect(persisted).toContain('source: search_overflow');
    expect(persisted).toContain('content_length:');
  });
});
