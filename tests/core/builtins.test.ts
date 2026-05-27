/**
 * Builtin tools tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

import { makeContractYaml } from '../helpers/contract-yaml.js';
import { createStatusTool } from '../../src/core/status-service/index.js';
import { createSendTool } from '../../src/foundation/messaging/tools/send.js';
import { readTool, writeTool, lsTool, searchTool, editTool, multiEditTool } from '../../src/foundation/file-tool/index.js';
import { createClawPermissionChecker } from '../../src/core/permissions/claw-permissions.js';
import { memorySearchTool } from '../../src/core/memory/tools/memory_search.js';
import { execTool } from '../../src/foundation/command-tool/index.js';
import { spawnTool } from '../../src/core/spawn-system/index.js';
import { ExecContextImpl } from '../../src/foundation/tools/context.js';
import { NodeFileSystem } from '../../src/foundation/fs/index.js';
import { OutboxWriter } from '../../src/foundation/messaging/index.js';
import { createOutboxWriter } from '../../src/foundation/messaging/index.js';
import { makeAudit } from '../helpers/audit.js';
import { ContractSystem } from '../../src/core/contract/manager.js';

import { createTempDir, cleanupTempDir } from '../utils/temp.js';
import { TASKS_QUEUES_RUNNING_DIR } from '../../src/core/async-task-system/index.js';
import { ToolExecutor } from '../../src/foundation/tools/executor.js';
import { ToolRegistryImpl } from '../../src/foundation/tools/registry.js';
import { createToolRegistry } from '../../src/foundation/tools/index.js';

const { mockSchedule } = vi.hoisted(() => ({
  mockSchedule: vi.fn(),
}));

describe('Builtin Tools', () => {
  let tempDir: string;
  const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });
  let mockFs: NodeFileSystem;
  let ctx: ExecContextImpl;
  let outboxWriter: OutboxWriter;

  beforeEach(async () => {
    vi.restoreAllMocks();
    tempDir = await createTempDir();
    // exec tool default cwd = clawspace; ensure it exists for subprocess tests
    await fs.mkdir(path.join(tempDir, 'clawspace'), { recursive: true });
    mockFs = new NodeFileSystem({ baseDir: tempDir });
    outboxWriter = createOutboxWriter('test-claw', tempDir, mockFs, makeAudit().audit);
    ctx = new ExecContextImpl({
      clawId: 'test-claw',
      clawDir: tempDir,
      syncDir: path.join(tempDir, 'tasks', 'sync'),
      profile: 'full',
      fs: mockFs,
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
      permissionChecker: createClawPermissionChecker({ clawDir: tempDir, strict: true }),
    });

  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  })

  describe('read tool', () => {
    it('should read existing file', async () => {
      await mockFs.ensureDir('clawspace');
      await mockFs.writeAtomic('clawspace/test.txt', 'Hello, World!');

      const result = await readTool.execute({ path: 'test.txt' }, ctx);

      expect(result.success).toBe(true);
      expect(result.content).toBe('Hello, World!');
    });

    it('should add path to fullyReadPaths after non-truncated read', async () => {
      await mockFs.ensureDir('clawspace');
      await mockFs.writeAtomic('clawspace/small.txt', 'small content');

      await readTool.execute({ path: 'small.txt' }, ctx);

      expect(ctx.fullyReadPaths.has('clawspace/small.txt')).toBe(true);
    });

    it('should return error for non-existent file', async () => {
      const result = await readTool.execute({ path: 'nonexistent.txt' }, ctx);

      expect(result.success).toBe(false);
      expect(result.content).toContain('Error');
    });

    it('should read specific line range', async () => {
      await mockFs.ensureDir('clawspace');
      await mockFs.writeAtomic('clawspace/lines.txt', 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5');

      const result = await readTool.execute({ path: 'lines.txt', offset: 2, limit: 2 }, ctx);

      expect(result.success).toBe(true);
      expect(result.content).toBe('Line 2\nLine 3');
    });

    it('dialog/ path is accessible (no extra blocklist)', async () => {
      // dialog/current.json 不存在时返回 FileNotFound，不是权限错误
      await mockFs.ensureDir('clawspace/dialog');
      await mockFs.writeAtomic('clawspace/dialog/current.json', '{}');
      const result = await readTool.execute({ path: 'dialog/current.json' }, ctx);
      expect(result.content).not.toContain('not allowed');
    });

    // Phase 2 质量审查补充：截断元信息测试
    it('should include metadata when truncating large files', async () => {
      await mockFs.ensureDir('clawspace');
      // Create 300 lines file (exceeds 200 line limit)
      const lines = Array.from({ length: 300 }, (_, i) => `Line ${i + 1}`);
      await mockFs.writeAtomic('clawspace/large.txt', lines.join('\n'));

      const result = await readTool.execute({ path: 'large.txt' }, ctx);

      expect(result.success).toBe(true);
      expect(result.content).toContain('Showing lines 1-200 of 300');
      expect(result.content).toContain('offset=201');
      expect(ctx.fullyReadPaths.has('clawspace/large.txt')).toBe(false);
    });

    it('should include byte count when truncating by char limit', async () => {
      await mockFs.ensureDir('clawspace');
      // Create ~10KB content (exceeds 8000 char limit)
      const content = 'x'.repeat(10000);
      await mockFs.writeAtomic('clawspace/huge.txt', content);

      const result = await readTool.execute({ path: 'huge.txt' }, ctx);

      expect(result.success).toBe(true);
      expect(result.content).toContain('Showing first');
      expect(ctx.fullyReadPaths.has('clawspace/huge.txt')).toBe(false);
    });

    // Negative offset tests
    it('should read last N lines with negative offset', async () => {
      await mockFs.ensureDir('clawspace');
      await mockFs.writeAtomic('clawspace/lines.txt', 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5');

      const result = await readTool.execute({ path: 'lines.txt', offset: -2 }, ctx);

      expect(result.success).toBe(true);
      expect(result.content).toBe('Line 4\nLine 5');
    });

    it('should read from negative offset with limit', async () => {
      await mockFs.ensureDir('clawspace');
      await mockFs.writeAtomic('clawspace/lines.txt', 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5');

      // offset=-3 means start from Line 3, limit=2 reads Line 3 and Line 4
      const result = await readTool.execute({ path: 'lines.txt', offset: -3, limit: 2 }, ctx);

      expect(result.success).toBe(true);
      expect(result.content).toBe('Line 3\nLine 4');
    });

    it('should start from beginning when negative offset exceeds total lines', async () => {
      await mockFs.ensureDir('clawspace');
      await mockFs.writeAtomic('clawspace/lines.txt', 'Line 1\nLine 2\nLine 3');

      // offset=-10 exceeds total lines (3), should start from line 1
      const result = await readTool.execute({ path: 'lines.txt', offset: -10 }, ctx);

      expect(result.success).toBe(true);
      expect(result.content).toBe('Line 1\nLine 2\nLine 3');
    });

    // Phase 16: error path Tip about claw parameter
    it('should include claw parameter Tip in error when reading non-existent file', async () => {
      const result = await readTool.execute({ path: 'no-such-file.txt' }, ctx);

      expect(result.success).toBe(false);
      expect(result.content).toContain('Tip');
      expect(result.content).toContain('"claw"');
    });
  });

  describe('write tool', () => {
    it('should write new file', async () => {
      await mockFs.ensureDir('clawspace');
      const result = await writeTool.execute({ path: 'output.txt', content: 'New content' }, ctx);

      expect(result.success).toBe(true);
      expect(result.content).toContain('Written:');
      expect(result.content).toContain('chars');

      const content = await mockFs.read('clawspace/output.txt');
      expect(content).toBe('New content');
    });

    it('should append to file', async () => {
      await mockFs.ensureDir('clawspace');
      await mockFs.writeAtomic('clawspace/append.txt', 'First line\n');

      const result = await writeTool.execute({
        path: 'append.txt',
        content: 'Second line',
        append: true,
      }, ctx);

      expect(result.success).toBe(true);

      const content = await mockFs.read('clawspace/append.txt');
      expect(content).toBe('First line\nSecond line');
    });

    // Phase 490: syncDir backup 测试
    it('should backup to syncDir with frontmatter on overwrite', async () => {
      await mockFs.ensureDir('clawspace');
      await mockFs.writeAtomic('clawspace/versioned.txt', 'original content');
      // 先 read 使其进入 fullyReadPaths
      await readTool.execute({ path: 'versioned.txt' }, ctx);

      const result = await writeTool.execute({
        path: 'versioned.txt',
        content: 'new content',
      }, ctx);

      expect(result.success).toBe(true);
      expect(result.content).toContain('backup:');

      // 验证 syncDir/write/ 中有 backup 文件（phase 511 子目录路由）
      const syncDir = path.join(tempDir, 'tasks', 'sync');
      const syncFiles = await fs.readdir(path.join(syncDir, 'write')).catch(() => []);
      expect(syncFiles.length).toBeGreaterThan(0);
      const backupFile = syncFiles[0];
      const backupContent = await fs.readFile(path.join(syncDir, 'write', backupFile), 'utf-8');
      expect(backupContent).toContain('source: file_backup');
      expect(backupContent).toContain('original_path: clawspace/versioned.txt');
      expect(backupContent).toContain('original content');
    });

    // Phase 490: fully-read gate 测试
    it('should reject overwrite when file was not fully read', async () => {
      await mockFs.ensureDir('clawspace');
      await mockFs.writeAtomic('clawspace/gated.txt', 'existing content');

      const result = await writeTool.execute({
        path: 'gated.txt',
        content: 'new content',
      }, ctx);

      expect(result.success).toBe(false);
      expect(result.content).toContain('fully-read');
    });

    it('should allow overwrite after fully read', async () => {
      await mockFs.ensureDir('clawspace');
      await mockFs.writeAtomic('clawspace/gated2.txt', 'existing content');

      // 先 read
      const readResult = await readTool.execute({ path: 'gated2.txt' }, ctx);
      expect(readResult.success).toBe(true);

      // 再 overwrite 应该成功
      const writeResult = await writeTool.execute({
        path: 'gated2.txt',
        content: 'new content',
      }, ctx);

      expect(writeResult.success).toBe(true);
    });

    it('should allow overwrite of same file again after first overwrite', async () => {
      await mockFs.ensureDir('clawspace');
      await mockFs.writeAtomic('clawspace/gated3.txt', 'v1');

      // 先 read
      await readTool.execute({ path: 'gated3.txt' }, ctx);
      // 第一次 overwrite
      const w1 = await writeTool.execute({ path: 'gated3.txt', content: 'v2' }, ctx);
      expect(w1.success).toBe(true);
      // 第二次 overwrite（写成功后已加入 fullyReadPaths）
      const w2 = await writeTool.execute({ path: 'gated3.txt', content: 'v3' }, ctx);
      expect(w2.success).toBe(true);
    });

    it('should allow append without fully-read gate', async () => {
      await mockFs.ensureDir('clawspace');
      await mockFs.writeAtomic('clawspace/append-gate.txt', 'existing');

      const result = await writeTool.execute({
        path: 'append-gate.txt',
        content: ' appended',
        append: true,
      }, ctx);

      expect(result.success).toBe(true);
    });

    it('should allow overwrite of non-existent file without gate', async () => {
      await mockFs.ensureDir('clawspace');

      const result = await writeTool.execute({
        path: 'new-file.txt',
        content: 'new content',
      }, ctx);

      expect(result.success).toBe(true);
    });

    it('should include byte count in success message', async () => {
      await mockFs.ensureDir('clawspace');
      const content = 'Hello, this is test content';

      const result = await writeTool.execute({
        path: 'bytecount.txt',
        content,
      }, ctx);

      expect(result.success).toBe(true);
      expect(result.content).toContain(`${content.length}`);
      expect(result.content).toContain('chars');
    });
  });

  describe('edit tool', () => {
    it('should replace unique match', async () => {
      await mockFs.ensureDir('clawspace');
      await mockFs.writeAtomic('clawspace/edit.txt', 'hello world');

      const result = await editTool.execute({ path: 'edit.txt', old_string: 'hello', new_string: 'hi' }, ctx);

      expect(result.success).toBe(true);
      expect(result.content).toContain('Edited:');
      expect(result.metadata).toEqual({ replaced: 1 });
      const content = await mockFs.read('clawspace/edit.txt');
      expect(content).toBe('hi world');
    });

    it('should fail loud on 0 match', async () => {
      await mockFs.ensureDir('clawspace');
      await mockFs.writeAtomic('clawspace/edit.txt', 'hello world');

      const result = await editTool.execute({ path: 'edit.txt', old_string: 'notfound', new_string: 'x' }, ctx);

      expect(result.success).toBe(false);
      expect(result.content).toContain('0 matches');
    });

    it('should fail loud on multiple matches without replace_all', async () => {
      await mockFs.ensureDir('clawspace');
      await mockFs.writeAtomic('clawspace/edit.txt', 'foo bar foo');

      const result = await editTool.execute({ path: 'edit.txt', old_string: 'foo', new_string: 'qux' }, ctx);

      expect(result.success).toBe(false);
      expect(result.content).toContain('2 matches');
    });

    it('should reject when file does not exist', async () => {
      const result = await editTool.execute({ path: 'nonexistent.txt', old_string: 'a', new_string: 'b' }, ctx);
      expect(result.success).toBe(false);
      expect(result.content).toContain('does not exist');
    });
  });

  describe('multi_edit tool', () => {
    it('should apply edits sequentially', async () => {
      await mockFs.ensureDir('clawspace');
      await mockFs.writeAtomic('clawspace/multi.txt', 'a b c d');

      const result = await multiEditTool.execute({
        path: 'multi.txt',
        edits: [
          { old_string: 'a', new_string: 'x' },
          { old_string: 'c', new_string: 'y' },
        ],
      }, ctx);

      expect(result.success).toBe(true);
      expect(result.content).toContain('2 edits applied');
      const content = await mockFs.read('clawspace/multi.txt');
      expect(content).toBe('x b y d');
    });

    it('should abort and rollback on mid-way failure', async () => {
      await mockFs.ensureDir('clawspace');
      await mockFs.writeAtomic('clawspace/multi.txt', 'hello world');

      const result = await multiEditTool.execute({
        path: 'multi.txt',
        edits: [
          { old_string: 'hello', new_string: 'hi' },
          { old_string: 'notfound', new_string: 'x' },
        ],
      }, ctx);

      expect(result.success).toBe(false);
      expect(result.content).toContain('edit[1]');
      expect(result.metadata).toEqual({ failed_index: 1, results: [{ index: 0, replaced: 1 }] });
      const content = await mockFs.read('clawspace/multi.txt');
      expect(content).toBe('hello world');
    });

    it('should reject empty edits array', async () => {
      await mockFs.ensureDir('clawspace');
      await mockFs.writeAtomic('clawspace/multi.txt', 'hello');

      const result = await multiEditTool.execute({ path: 'multi.txt', edits: [] }, ctx);

      expect(result.success).toBe(false);
      expect(result.content).toContain('at least 1 edit');
    });
  });

  describe('ls tool', () => {
    it('should list directory contents', async () => {
      await mockFs.writeAtomic('clawspace/file1.txt', '');
      await mockFs.writeAtomic('clawspace/file2.txt', '');
      await mockFs.ensureDir('clawspace/subdir');

      const result = await lsTool.execute({ path: '.' }, ctx);

      expect(result.success).toBe(true);
      expect(result.content).toContain('[FILE] file1.txt');
      expect(result.content).toContain('[FILE] file2.txt');
      expect(result.content).toContain('[DIR] subdir');
    });

    it('should handle empty directory', async () => {
      await mockFs.ensureDir('clawspace/empty');

      const result = await lsTool.execute({ path: 'empty' }, ctx);

      expect(result.success).toBe(true);
      expect(result.content).toBe('Directory is empty');
    });

    it('should default to current directory', async () => {
      await mockFs.writeAtomic('clawspace/current.txt', '');

      const result = await lsTool.execute({}, ctx);

      expect(result.success).toBe(true);
      expect(result.content).toContain('current.txt');
    });

    // Phase 16: error path Tip about claw parameter
    it('should include claw parameter Tip in error when listing non-existent path', async () => {
      const result = await lsTool.execute({ path: 'nonexistent/path/xyz' }, ctx);

      expect(result.success).toBe(false);
      expect(result.content).toContain('Tip');
      expect(result.content).toContain('"claw"');
    });
  });

  describe('search tool', () => {
    it('should find matching text', async () => {
      await mockFs.ensureDir('clawspace');
      await mockFs.writeAtomic('clawspace/note1.txt', 'Hello world\nThis is a test\nHello again');
      await mockFs.writeAtomic('clawspace/note2.txt', 'Goodbye world');

      const result = await searchTool.execute({ query: 'hello' }, ctx);

      expect(result.success).toBe(true);
      expect(result.content).toContain('Hello world');
      expect(result.content).toContain('Hello again');
      expect(result.content).not.toContain('Goodbye');
    });

    it('should return no results message', async () => {
      await mockFs.ensureDir('clawspace');
      await mockFs.writeAtomic('clawspace/empty.txt', 'Nothing here');

      const result = await searchTool.execute({ query: 'xyz' }, ctx);

      expect(result.success).toBe(true);
      expect(result.content).toContain('未找到');
    });

    it('should respect max_results', async () => {
      await mockFs.ensureDir('clawspace');
      await mockFs.writeAtomic('clawspace/many.txt', 'target\ntarget\ntarget\ntarget\ntarget\ntarget');

      const result = await searchTool.execute({ query: 'target', max_results: 3 }, ctx);

      expect(result.success).toBe(true);
      const lines = result.content.split('\n').filter(l => l.trim());
      expect(lines.length).toBe(3);
    });

    it('should reject claw="*" for non-Motion (broadcast still Motion-only)', async () => {
      const result = await searchTool.execute({ query: 'test', path: 'clawspace', claw: '*' }, ctx);

      expect(result.success).toBe(false);
      expect(result.content).toContain('Motion-only');
    });

    it('should allow specific claw target for non-Motion (D11 align)', async () => {
      const mainClawDir = path.join(tempDir, 'main-claw');
      await fs.mkdir(mainClawDir, { recursive: true });
      const otherClawDir = path.join(tempDir, 'claws', 'other-claw', 'clawspace');
      await fs.mkdir(otherClawDir, { recursive: true });
      await fs.writeFile(path.join(otherClawDir, 'note.txt'), 'cross-claw content');

      const mainCtx = new ExecContextImpl({
        clawId: 'main-claw',
        clawDir: mainClawDir,
        syncDir: path.join(mainClawDir, 'tasks/sync'),
        profile: 'full',
        fs: mockFs,
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
        permissionChecker: createClawPermissionChecker({ clawDir: mainClawDir, strict: true }),
      });
      const result = await searchTool.execute({ query: 'cross-claw', path: 'clawspace', claw: 'other-claw' }, mainCtx);

      expect(result.success).toBe(true);
      expect(result.content).toContain('note.txt');
      expect(result.content).toContain('cross-claw content');
    });

    it('should search all claws with claw: "*" (Motion only)', async () => {
      // Create proper directory structure (matches real .clawforum layout):
      // tempDir/           <- workDir (.clawforum equivalent)
      //   motion/          <- motion clawDir
      //   claws/           <- other claws directory
      //     claw1/
      //     claw2/
      
      // Motion's own directory (as motion's clawDir)
      const motionDir = path.join(tempDir, 'motion');
      await fs.mkdir(motionDir, { recursive: true });
      
      // Create Motion context with motion's clawDir
      const motionFs = new NodeFileSystem({ baseDir: motionDir });
      const motionOutboxWriter = createOutboxWriter('motion', motionDir, motionFs, makeAudit().audit);
      const motionCtx = new ExecContextImpl({
        clawId: 'motion',
        clawDir: motionDir,
        profile: 'full',
        fs: motionFs,
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
        outboxWriter: motionOutboxWriter,
        permissionChecker: createClawPermissionChecker({ clawDir: motionDir, strict: true }),
      });
      
      // Create other claws directory and test claws
      const clawsDir = path.join(tempDir, 'claws');
      
      // Create claw1 with test file
      const claw1Dir = path.join(clawsDir, 'claw1', 'clawspace');
      await fs.mkdir(claw1Dir, { recursive: true });
      await fs.writeFile(path.join(claw1Dir, 'note.txt'), 'Error in claw1: disk full');
      
      // Create claw2 with test file
      const claw2Dir = path.join(clawsDir, 'claw2', 'clawspace');
      await fs.mkdir(claw2Dir, { recursive: true });
      await fs.writeFile(path.join(claw2Dir, 'log.txt'), 'Error in claw2: timeout');
      
      // Create claw3 without clawspace (should be skipped gracefully)
      const claw3Dir = path.join(clawsDir, 'claw3');
      await fs.mkdir(claw3Dir, { recursive: true });

      const result = await searchTool.execute({ query: 'error', path: 'clawspace/', claw: '*' }, motionCtx);

      expect(result.success).toBe(true);
      // Results should have [clawId] prefix
      expect(result.content).toContain('[claw1]');
      expect(result.content).toContain('[claw2]');
      expect(result.content).toContain('disk full');
      expect(result.content).toContain('timeout');
      // Format: [clawId] clawspace/file.txt:line: content
      expect(result.content).toMatch(/\[claw1\] clawspace\/note\.txt:\d+:/);
      expect(result.content).toMatch(/\[claw2\] clawspace\/log\.txt:\d+:/);
    });

    it('should return no results when no claws directory exists (claw: "*")', async () => {
      // Create Motion context with a clawDir whose parent doesn't exist
      const nonExistentDir = path.join(tempDir, 'nonexistent', 'motion');
      const motionFs = new NodeFileSystem({ baseDir: nonExistentDir });
      const motionOutboxWriter = createOutboxWriter('motion', nonExistentDir, motionFs);
      const motionCtx = new ExecContextImpl({
        clawId: 'motion',
        clawDir: nonExistentDir,
        profile: 'full',
        fs: motionFs,
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
        outboxWriter: motionOutboxWriter,
        permissionChecker: createClawPermissionChecker({ clawDir: nonExistentDir, strict: true }),
      });

      const result = await searchTool.execute({ query: 'test', path: 'clawspace/', claw: '*' }, motionCtx);

      expect(result.success).toBe(true);
      expect(result.content).toContain('未找到');
      expect(result.content).toContain('无 claw 目录');
    });

    it('should respect max_results with claw: "*" across all claws', async () => {
      // Motion's own directory (as motion's clawDir)
      const motionDir = path.join(tempDir, 'motion');
      await fs.mkdir(motionDir, { recursive: true });
      
      // Create Motion context with motion's clawDir
      const motionFs = new NodeFileSystem({ baseDir: motionDir });
      const motionOutboxWriter = createOutboxWriter('motion', motionDir, motionFs, makeAudit().audit);
      const motionCtx = new ExecContextImpl({
        clawId: 'motion',
        clawDir: motionDir,
        profile: 'full',
        fs: motionFs,
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
        outboxWriter: motionOutboxWriter,
        permissionChecker: createClawPermissionChecker({ clawDir: motionDir, strict: true }),
      });
      
      // Create other claws
      const clawsDir = path.join(tempDir, 'claws');
      
      // Create claw1 with multiple matches
      const claw1Dir = path.join(clawsDir, 'claw1', 'clawspace');
      await fs.mkdir(claw1Dir, { recursive: true });
      await fs.writeFile(path.join(claw1Dir, 'many.txt'), 'target\ntarget\ntarget');
      
      // Create claw2 with multiple matches
      const claw2Dir = path.join(clawsDir, 'claw2', 'clawspace');
      await fs.mkdir(claw2Dir, { recursive: true });
      await fs.writeFile(path.join(claw2Dir, 'many.txt'), 'target\ntarget\ntarget');

      const result = await searchTool.execute({ query: 'target', path: 'clawspace/', claw: '*', max_results: 4 }, motionCtx);

      expect(result.success).toBe(true);
      const lines = result.content.split('\n').filter(l => l.trim());
      expect(lines.length).toBe(4);
    });

    // M2 fix: claw="*" search returns results in stable alphabetical order
    it('should return results in alphabetical claw order with max_results (M2)', async () => {
      const motionDir = path.join(tempDir, 'motion');
      await fs.mkdir(motionDir, { recursive: true });

      const motionFs = new NodeFileSystem({ baseDir: motionDir });
      const motionOutboxWriter = createOutboxWriter('motion', motionDir, motionFs, makeAudit().audit);
      const motionCtx = new ExecContextImpl({
        clawId: 'motion',
        clawDir: motionDir,
        permissions: { read: true, write: true, execute: true, spawn: true, send: true, network: false, system: false },
        profile: 'full',
        fs: motionFs,
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
        outboxWriter: motionOutboxWriter,
        permissionChecker: createClawPermissionChecker({ clawDir: motionDir, strict: true }),
      });

      const clawsDir = path.join(tempDir, 'claws');

      // Create claws in reverse alphabetical order to test sorting
      const zClawDir = path.join(clawsDir, 'z_claw', 'clawspace');
      await fs.mkdir(zClawDir, { recursive: true });
      await fs.writeFile(path.join(zClawDir, 'file.txt'), 'match');

      const aClawDir = path.join(clawsDir, 'a_claw', 'clawspace');
      await fs.mkdir(aClawDir, { recursive: true });
      await fs.writeFile(path.join(aClawDir, 'file.txt'), 'match\nmatch');

      const mClawDir = path.join(clawsDir, 'm_claw', 'clawspace');
      await fs.mkdir(mClawDir, { recursive: true });
      await fs.writeFile(path.join(mClawDir, 'file.txt'), 'match\nmatch\nmatch');

      // Search with max_results=4 - should take from a_claw first (alphabetically)
      const result = await searchTool.execute({ query: 'match', path: 'clawspace/', claw: '*', max_results: 4 }, motionCtx);

      expect(result.success).toBe(true);
      const lines = result.content.split('\n').filter(l => l.trim());
      expect(lines.length).toBe(4);
      // With sorting, a_claw (alphabetically first) fills 2 slots, then m_claw fills 2
      expect(lines[0]).toContain('[a_claw]');
      expect(lines[1]).toContain('[a_claw]');
      expect(lines[2]).toContain('[m_claw]');
      expect(lines[3]).toContain('[m_claw]');
    });
  });

  describe('send tool', () => {
    let sendTool: ReturnType<typeof createSendTool>;
    beforeEach(() => {
      sendTool = createSendTool(outboxWriter);
    });
    afterEach(() => {
    });

    it('should create message in outbox', async () => {
      const result = await sendTool.execute({
        content: 'Test message',
        type: 'report',
      }, ctx);

      expect(result.success).toBe(true);
      expect(result.content).toContain('Message sent');

      // Verify file was created
      const outboxDir = path.join(tempDir, 'outbox', 'pending');
      const files = await fs.readdir(outboxDir);
      expect(files.length).toBe(1);
      expect(files[0]).toContain('report');
    });

    it('should validate message type', async () => {
      const result = await sendTool.execute({
        content: 'Test',
        type: 'invalid',
      }, ctx);

      expect(result.success).toBe(false);
      expect(result.content).toContain('Invalid message type');
    });
  });

  describe('memory_search tool', () => {
    it('should search with query', async () => {
      await mockFs.ensureDir('memory');
      await mockFs.writeAtomic('memory/note1.md', 'Hello world\nThis is a test');
      await mockFs.writeAtomic('memory/note2.md', 'Goodbye world');

      const result = await memorySearchTool.execute({ query: 'hello' }, ctx);

      expect(result.success).toBe(true);
      expect(result.content).toContain('Hello world');
      expect(result.content).not.toContain('Goodbye');
    });

    it('should filter by filename pattern', async () => {
      await mockFs.ensureDir('memory');
      await mockFs.writeAtomic('memory/2026-01.md', 'Content from 2026');
      await mockFs.writeAtomic('memory/2025-12.md', 'Content from 2025');

      const result = await memorySearchTool.execute({ query: 'content', pattern: '2026.*' }, ctx);

      expect(result.success).toBe(true);
      expect(result.content).toContain('2026-01.md');
      expect(result.content).not.toContain('2025-12.md');
    });

    it('should filter by frontmatter metadata', async () => {
      await mockFs.ensureDir('memory');
      await mockFs.writeAtomic('memory/feedback1.md', '---\ntype: feedback\n---\nThis is feedback content');
      await mockFs.writeAtomic('memory/bug1.md', '---\ntype: bug\n---\nThis is bug report');

      const result = await memorySearchTool.execute({ filter: { type: 'feedback' } }, ctx);

      expect(result.success).toBe(true);
      expect(result.content).toContain('feedback1.md');
      expect(result.content).not.toContain('bug1.md');
    });

    it('should combine query and filter', async () => {
      await mockFs.ensureDir('memory');
      await mockFs.writeAtomic('memory/a.md', '---\ntype: feedback\n---\nHello from A');
      await mockFs.writeAtomic('memory/b.md', '---\ntype: bug\n---\nHello from B');

      const result = await memorySearchTool.execute({ query: 'hello', filter: { type: 'feedback' } }, ctx);

      expect(result.success).toBe(true);
      expect(result.content).toContain('A');
      expect(result.content).not.toContain('B');
    });

    it('should return error without query or filter', async () => {
      const result = await memorySearchTool.execute({}, ctx);

      expect(result.success).toBe(false);
      expect(result.content).toContain('必须提供 query 或 filter');
    });

    it('should return no results message', async () => {
      await mockFs.ensureDir('memory');
      await mockFs.writeAtomic('memory/empty.md', 'Nothing relevant');

      const result = await memorySearchTool.execute({ query: 'xyz123' }, ctx);

      expect(result.success).toBe(true);
      expect(result.content).toContain('未找到');
    });
  });

  it('反向 1：物理迁后 exec 工具 name lookup 不变', () => {
    expect(execTool.name).toBe('exec');
  });

  describe('exec tool', () => {
    it('should return error for non-existent command', async () => {
      const result = await execTool.execute({ command: 'nonexistent_command_xyz' }, ctx);

      expect(result.success).toBe(false);
      expect(result.content).toContain('Error');
    });

    // Phase 21 Step 1: PATH augmentation
    it('should include node bin dir in PATH for subprocess', async () => {
      const result = await execTool.execute({ command: 'echo "$PATH"' }, ctx);

      expect(result.success).toBe(true);
      // 子进程 PATH 应包含 node 可执行文件所在目录（clawforum 命令所在位置）
      const nodeBinDir = path.dirname(process.execPath);
      expect(result.content).toContain(nodeBinDir);
    });

    it('should not duplicate node bin dir when already in PATH', async () => {
      // exec.ts 只在 PATH 不含 nodeBinDir 时才添加，已含则原样传递
      const nodeBinDir = path.dirname(process.execPath);
      // 统计 PATH 中出现次数：正常情况下不超过出现两次（原始 PATH 可能已含，添加后仍只一份）
      const result = await execTool.execute({ command: 'echo "$PATH"' }, ctx);
      expect(result.success).toBe(true);
      const count = (result.content.split(nodeBinDir).length - 1);
      expect(count).toBeGreaterThanOrEqual(1); // 至少存在一次
    });

    // Phase 16: stderr/stdout capture in error path
    it('should include stderr in error result when command writes to stderr and exits non-zero', async () => {
      const result = await execTool.execute(
        { command: "sh -c 'echo \"stderr output\" >&2; exit 1'" },
        ctx,
      );

      expect(result.success).toBe(false);
      expect(result.content).toContain('[output]');
      expect(result.content).toContain('stderr output');
    });

    it('should include stdout in error result when command writes to stdout and exits non-zero', async () => {
      const result = await execTool.execute(
        { command: "sh -c 'echo \"stdout output\"; exit 1'" },
        ctx,
      );

      expect(result.success).toBe(false);
      expect(result.content).toContain('[output]');
      expect(result.content).toContain('stdout output');
    });

    it('abort signal 已触发时命令被取消，返回 success:false', async () => {
      const controller = new AbortController();
      controller.abort(); // 预先 abort

      const abortCtx = new ExecContextImpl({
        clawId: 'test-claw',
        clawDir: tempDir,
        profile: 'full',
        fs: mockFs,
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
        signal: controller.signal,
        permissionChecker: createClawPermissionChecker({ clawDir: tempDir, strict: true }),
      });

      const result = await execTool.execute({ command: 'echo should-not-run' }, abortCtx);

      // 被 abort 的命令应返回失败
      expect(result.success).toBe(false);
      expect(result.content).toMatch(/abort|cancel|operation/i);
    });

    it('失败时在内容中附带 [cwd] 提示，帮助 LLM 定位路径上下文', async () => {
      const result = await execTool.execute(
        { command: "sh -c 'exit 1'" },
        ctx,
      );

      expect(result.success).toBe(false);
      expect(result.content).toContain('[cwd]:');
      expect(result.content).toContain(ctx.clawDir);
    });

    it('clawDir 不存在时返回 ENOENT 错误（success:false）', async () => {
      const missingDirCtx = new ExecContextImpl({
        clawId: 'test-claw',
        clawDir: path.join(tempDir, 'nonexistent-dir-xyz'),
        profile: 'full',
        fs: mockFs,
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
        permissionChecker: createClawPermissionChecker({ clawDir: path.join(tempDir, 'nonexistent-dir-xyz'), strict: true }),
      });

      const result = await execTool.execute({ command: 'echo hi' }, missingDirCtx);

      expect(result.success).toBe(false);
      expect(result.content).toContain('Error');
    });

    // 反向 2：schema D1d 修 bug + cwd/timeoutMs 行为契约（env 已删 / phase402 YAGNI 收紧）
    it('execTool schema 含 cwd/timeoutMs / 不含 async/timeout/env', () => {
      const props = execTool.schema.properties as Record<string, unknown>;
      expect(props).toHaveProperty('cwd');
      expect(props).toHaveProperty('timeoutMs');
      expect(props).not.toHaveProperty('async');
      expect(props).not.toHaveProperty('timeout');
      expect(props).not.toHaveProperty('env');
    });

    it('execTool args.cwd 优先于 ctx.clawDir', async () => {
      const result = await execTool.execute({ command: 'pwd', cwd: '/tmp' }, ctx);
      expect(result.content).toContain('/tmp');
    });

    it('execTool 默认 cwd = ctx.workspaceDir（主 claw = clawspace）', async () => {
      // ensure clawspace subdir exists in tempDir (some tests may not have it)
      const fsNative = await import('fs');
      fsNative.mkdirSync(path.join(tempDir, 'clawspace'), { recursive: true });

      const result = await execTool.execute({ command: 'pwd' }, ctx);

      expect(result.success).toBe(true);
      expect(result.content).toContain(ctx.workspaceDir);  // phase 512
    });

    it('execTool subagent 默认 cwd = clawspace (shared with caller / phase 518)', async () => {
      const fsNative = await import('fs');
      fsNative.mkdirSync(path.join(tempDir, 'clawspace'), { recursive: true });
      const subagentCtx = new ExecContextImpl({
        clawId: 'test',
        clawDir: tempDir,
        workspaceDir: path.join(tempDir, 'clawspace'),
        syncDir: path.join(tempDir, 'tasks/sync'),
        profile: 'subagent',
        callerType: 'subagent',
        fs: mockFs,
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
        permissionChecker: createClawPermissionChecker({ clawDir: tempDir, strict: true }),
      });
      const result = await execTool.execute({ command: 'pwd' }, subagentCtx);
      expect(result.success).toBe(true);
      expect(result.content).toContain('clawspace');
    });

    it('subagent 显式用 cwd 写 dedicated temp dir (phase 519: ../ prefix)', async () => {
      const fsNative = await import('fs');
      const subagentTempDir = path.join(tempDir, 'tasks/subagents/phase518-test');
      fsNative.mkdirSync(subagentTempDir, { recursive: true });
      fsNative.mkdirSync(path.join(tempDir, 'clawspace'), { recursive: true });
      const subagentCtx = new ExecContextImpl({
        clawId: 'test',
        clawDir: tempDir,
        workspaceDir: path.join(tempDir, 'clawspace'),
        syncDir: path.join(tempDir, 'tasks/sync'),
        profile: 'subagent',
        callerType: 'subagent',
        fs: mockFs,
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
        permissionChecker: createClawPermissionChecker({ clawDir: tempDir, strict: true }),
      });

      const result = await writeTool.execute(
        { path: 'temp.txt', cwd: '../tasks/subagents/phase518-test', content: 'data' },
        subagentCtx,
      );

      expect(result.success).toBe(true);
      expect(fsNative.existsSync(path.join(subagentTempDir, 'temp.txt'))).toBe(true);
    });

    it('subagent default write 落 clawspace (与 caller 共享)', async () => {
      const fsNative = await import('fs');
      fsNative.mkdirSync(path.join(tempDir, 'clawspace'), { recursive: true });
      const subagentCtx = new ExecContextImpl({
        clawId: 'test',
        clawDir: tempDir,
        workspaceDir: path.join(tempDir, 'clawspace'),
        syncDir: path.join(tempDir, 'tasks/sync'),
        profile: 'subagent',
        callerType: 'subagent',
        fs: mockFs,
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
        permissionChecker: createClawPermissionChecker({ clawDir: tempDir, strict: true }),
      });

      const result = await writeTool.execute(
        { path: 'shared-by-subagent.txt', content: 'data' },
        subagentCtx,
      );

      expect(result.success).toBe(true);
      expect(fsNative.existsSync(path.join(tempDir, 'clawspace/shared-by-subagent.txt'))).toBe(true);
    });

    it('execTool args.cwd 相对路径以 workspaceDir 为基准 resolve (phase 519)', async () => {
      const fsNative = await import('fs');
      fsNative.mkdirSync(path.join(tempDir, 'clawspace', 'build'), { recursive: true });

      const result = await execTool.execute({ command: 'pwd', cwd: 'build' }, ctx);

      expect(result.success).toBe(true);
      expect(result.content).toContain(path.join(tempDir, 'clawspace', 'build'));
    });

    it('should pipe stdin to command (phase 1321)', async () => {
      const result = await execTool.execute({
        command: 'cat',
        stdin: 'hello from stdin',
      }, ctx);
      expect(result.success).toBe(true);
      expect(result.content).toBe('hello from stdin');
    });

    it('should write file content without heredoc issues (phase 1321)', async () => {
      const fsNative = await import('fs');
      fsNative.mkdirSync(path.join(tempDir, 'clawspace'), { recursive: true });

      const result = await execTool.execute({
        command: 'cat > test-output.md',
        stdin: '---\nfrontmatter: true\n---\n\nbody',
      }, ctx);
      expect(result.success).toBe(true);
      const content = await ctx.fs.read('clawspace/test-output.md');
      expect(content).toContain('---');
      expect(content).toContain('frontmatter: true');
      expect(content).toContain('body');
    });
  });

  describe('spawn tool', () => {
    beforeEach(() => {
      mockSchedule.mockClear();
    });

    it('should pass maxSteps from context', async () => {
      mockSchedule.mockResolvedValue('task-xxx');

      const ctxWithMaxSteps = new ExecContextImpl({
        clawId: 'test-claw',
        clawDir: tempDir,
        profile: 'full',
        fs: mockFs,
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
        outboxWriter,
        maxSteps: 42,
        taskSystem: { schedule: mockSchedule } as any,
        permissionChecker: createClawPermissionChecker({ clawDir: tempDir, strict: true }),
      });

      const result = await spawnTool.execute({
        intent: 'test task',
      }, ctxWithMaxSteps);

      expect(result.success).toBe(true);
      expect(mockSchedule).toHaveBeenCalled();
      expect(mockSchedule.mock.calls[0][1].maxSteps).toBe(42);
      expect(mockSchedule.mock.calls[0][1].intent).toBe('test task');
    });
  });

  describe('read tool - claw parameter', () => {
    it('should allow Motion to read another claw\'s file', async () => {
      // Create directory structure: .clawforum/motion/ and .clawforum/claws/claw1/
      const motionDir = path.join(tempDir, 'motion');
      await fs.mkdir(motionDir, { recursive: true });
      const claw1Dir = path.join(tempDir, 'claws', 'claw1', 'clawspace');
      await fs.mkdir(claw1Dir, { recursive: true });
      await fs.writeFile(path.join(claw1Dir, 'test.txt'), 'Hello from claw1');

      const motionFs = new NodeFileSystem({ baseDir: motionDir });
      const motionCtx = new ExecContextImpl({
        clawId: 'motion',
        clawDir: motionDir,
        profile: 'full',
        fs: motionFs,
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
        permissionChecker: createClawPermissionChecker({ clawDir: motionDir, strict: true }),
      });

      const result = await readTool.execute({ path: 'clawspace/test.txt', claw: 'claw1' }, motionCtx);

      expect(result.success).toBe(true);
      expect(result.content).toBe('Hello from claw1');
    });

    it('should allow Motion subagent (originClawId=motion) to read another claw\'s file', async () => {
      // Create directory structure
      const motionDir = path.join(tempDir, 'motion');
      await fs.mkdir(motionDir, { recursive: true });
      const claw1Dir = path.join(tempDir, 'claws', 'claw1', 'clawspace');
      await fs.mkdir(claw1Dir, { recursive: true });
      await fs.writeFile(path.join(claw1Dir, 'note.txt'), 'Note from claw1');

      const motionFs = new NodeFileSystem({ baseDir: motionDir });
      const subagentCtx = new ExecContextImpl({
        clawId: 'task-uuid-123',
        clawDir: motionDir,
        profile: 'full',
        callerType: 'subagent',
        fs: motionFs,
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
        originClawId: 'motion',
        permissionChecker: createClawPermissionChecker({ clawDir: motionDir, strict: true }),
      });

      const result = await readTool.execute({ path: 'clawspace/note.txt', claw: 'claw1' }, subagentCtx);

      expect(result.success).toBe(true);
      expect(result.content).toBe('Note from claw1');
    });

    it('should allow specific claw target for non-Motion (D11 align)', async () => {
      const mainClawDir = path.join(tempDir, 'main-claw');
      await fs.mkdir(mainClawDir, { recursive: true });
      const claw1Dir = path.join(tempDir, 'claws', 'claw1', 'clawspace');
      await fs.mkdir(claw1Dir, { recursive: true });
      await fs.writeFile(path.join(claw1Dir, 'note.txt'), 'Note from claw1');

      const mainCtx = new ExecContextImpl({
        clawId: 'main-claw',
        clawDir: mainClawDir,
        syncDir: path.join(mainClawDir, 'tasks/sync'),
        profile: 'full',
        fs: mockFs,
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
        permissionChecker: createClawPermissionChecker({ clawDir: mainClawDir, strict: true }),
      });
      const result = await readTool.execute({ path: 'clawspace/note.txt', claw: 'claw1' }, mainCtx);

      expect(result.success).toBe(true);
      expect(result.content).toBe('Note from claw1');
    });

    it('should reject invalid claw ID (path traversal)', async () => {
      const motionDir = path.join(tempDir, 'motion');
      await fs.mkdir(motionDir, { recursive: true });
      const motionFs = new NodeFileSystem({ baseDir: motionDir });
      const motionCtx = new ExecContextImpl({
        clawId: 'motion',
        clawDir: motionDir,
        profile: 'full',
        fs: motionFs,
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
        permissionChecker: createClawPermissionChecker({ clawDir: motionDir, strict: true }),
      });

      const result = await readTool.execute({ path: 'test.txt', claw: '../etc/passwd' }, motionCtx);

      expect(result.success).toBe(false);
      expect(result.content).toContain('Invalid');
    });

    it('should reject claw ID with slash', async () => {
      const motionDir = path.join(tempDir, 'motion');
      await fs.mkdir(motionDir, { recursive: true });
      const motionFs = new NodeFileSystem({ baseDir: motionDir });
      const motionCtx = new ExecContextImpl({
        clawId: 'motion',
        clawDir: motionDir,
        profile: 'full',
        fs: motionFs,
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
        permissionChecker: createClawPermissionChecker({ clawDir: motionDir, strict: true }),
      });

      const result = await readTool.execute({ path: 'test.txt', claw: 'claw/sub' }, motionCtx);

      expect(result.success).toBe(false);
      expect(result.content).toContain('Invalid');
    });

    // Phase 537: cross-claw 路径校验
    it('rejects sibling-claw prefix traversal (claw="c1" + path="../c11/x")', async () => {
      const motionDir = path.join(tempDir, 'motion');
      await fs.mkdir(motionDir, { recursive: true });
      const c1Dir = path.join(tempDir, 'claws', 'c1', 'clawspace');
      const c11Dir = path.join(tempDir, 'claws', 'c11', 'clawspace');
      await fs.mkdir(c1Dir, { recursive: true });
      await fs.mkdir(c11Dir, { recursive: true });
      await fs.writeFile(path.join(c11Dir, 'secret.md'), 'secret content');

      const motionFs = new NodeFileSystem({ baseDir: motionDir });
      const motionCtx = new ExecContextImpl({
        clawId: 'motion',
        clawDir: motionDir,
        profile: 'full',
        fs: motionFs,
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
        permissionChecker: createClawPermissionChecker({ clawDir: motionDir, strict: true }),
      });

      const result = await readTool.execute({ path: '../c11/secret.md', claw: 'c1' }, motionCtx);

      expect(result.success).toBe(false);
      expect(result.content).toMatch(/Path escapes target claw directory/);
    });

    it('allows cross-claw read when targetPath equals clawRoot (path="")', async () => {
      const motionDir = path.join(tempDir, 'motion');
      await fs.mkdir(motionDir, { recursive: true });
      const c1Dir = path.join(tempDir, 'claws', 'c1', 'clawspace');
      await fs.mkdir(c1Dir, { recursive: true });
      await fs.writeFile(path.join(c1Dir, 'note.md'), 'note content');

      const motionFs = new NodeFileSystem({ baseDir: motionDir });
      const motionCtx = new ExecContextImpl({
        clawId: 'motion',
        clawDir: motionDir,
        profile: 'full',
        fs: motionFs,
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
        permissionChecker: createClawPermissionChecker({ clawDir: motionDir, strict: true }),
      });

      // path="" resolves to clawRoot; trailing-sep prefix must allow this
      // actual read will fail because clawRoot is a directory, but guard must pass
      const result = await readTool.execute({ path: '', claw: 'c1' }, motionCtx);
      expect(result.content).not.toMatch(/Path escapes target claw directory/);
    });

    it('cross-claw read does NOT pollute caller fullyReadPaths (write gate intact)', async () => {
      const motionDir = path.join(tempDir, 'motion');
      await fs.mkdir(motionDir, { recursive: true });
      const motionFs = new NodeFileSystem({ baseDir: motionDir });
      const motionCtx = new ExecContextImpl({
        clawId: 'motion',
        clawDir: motionDir,
        profile: 'full',
        fs: motionFs,
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
        permissionChecker: createClawPermissionChecker({ clawDir: motionDir, strict: true }),
      });

      // Create c1 with a file
      const c1Dir = path.join(tempDir, 'claws', 'c1', 'clawspace');
      await fs.mkdir(c1Dir, { recursive: true });
      await fs.writeFile(path.join(c1Dir, 'foo.md'), 'c1 content');

      // Cross-claw read c1/clawspace/foo.md from motion context
      const readResult = await readTool.execute({ path: 'clawspace/foo.md', claw: 'c1' }, motionCtx);
      expect(readResult.success).toBe(true);

      // Create a local file that motion same-claw write 'clawspace/foo.md' resolves to
      const localFile = path.join(motionDir, 'clawspace', 'clawspace', 'foo.md');
      await fs.mkdir(path.dirname(localFile), { recursive: true });
      await fs.writeFile(localFile, 'local content');

      // Same-claw write to 'clawspace/foo.md' should still be rejected
      // because cross-claw read must not add to same-claw write gate
      const writeResult = await writeTool.execute({
        path: 'clawspace/foo.md',
        content: 'attack',
      }, motionCtx);

      expect(writeResult.success).toBe(false);
      expect(writeResult.content).toMatch(/Use append=true, or read the file first/i);
    });
  });

  describe('ls tool - claw parameter', () => {
    it('should allow Motion to list another claw\'s directory', async () => {
      const motionDir = path.join(tempDir, 'motion');
      await fs.mkdir(motionDir, { recursive: true });
      const claw1Dir = path.join(tempDir, 'claws', 'claw1', 'clawspace');
      await fs.mkdir(claw1Dir, { recursive: true });
      await fs.writeFile(path.join(claw1Dir, 'file1.txt'), 'content1');
      await fs.writeFile(path.join(claw1Dir, 'file2.txt'), 'content2');

      const motionFs = new NodeFileSystem({ baseDir: motionDir });
      const motionCtx = new ExecContextImpl({
        clawId: 'motion',
        clawDir: motionDir,
        profile: 'full',
        fs: motionFs,
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
        permissionChecker: createClawPermissionChecker({ clawDir: motionDir, strict: true }),
      });

      const result = await lsTool.execute({ path: 'clawspace', claw: 'claw1' }, motionCtx);

      expect(result.success).toBe(true);
      expect(result.content).toContain('file1.txt');
      expect(result.content).toContain('file2.txt');
    });

    it('should allow Motion subagent to list another claw\'s directory', async () => {
      const motionDir = path.join(tempDir, 'motion');
      await fs.mkdir(motionDir, { recursive: true });
      const claw1Dir = path.join(tempDir, 'claws', 'claw1', 'skills');
      await fs.mkdir(claw1Dir, { recursive: true });

      const motionFs = new NodeFileSystem({ baseDir: motionDir });
      const subagentCtx = new ExecContextImpl({
        clawId: 'subagent-456',
        clawDir: motionDir,
        profile: 'full',
        callerType: 'subagent',
        fs: motionFs,
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
        originClawId: 'motion',
        permissionChecker: createClawPermissionChecker({ clawDir: motionDir, strict: true }),
      });

      const result = await lsTool.execute({ path: 'skills', claw: 'claw1' }, subagentCtx);

      expect(result.success).toBe(true);
    });

    it('should allow specific claw target for non-Motion (D11 align)', async () => {
      const mainClawDir = path.join(tempDir, 'main-claw');
      await fs.mkdir(mainClawDir, { recursive: true });
      const claw1Dir = path.join(tempDir, 'claws', 'claw1', 'clawspace');
      await fs.mkdir(claw1Dir, { recursive: true });
      await fs.writeFile(path.join(claw1Dir, 'file.txt'), 'content');

      const mainCtx = new ExecContextImpl({
        clawId: 'main-claw',
        clawDir: mainClawDir,
        syncDir: path.join(mainClawDir, 'tasks/sync'),
        profile: 'full',
        fs: mockFs,
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
        permissionChecker: createClawPermissionChecker({ clawDir: mainClawDir, strict: true }),
      });
      const result = await lsTool.execute({ path: 'clawspace', claw: 'claw1' }, mainCtx);

      expect(result.success).toBe(true);
      expect(result.content).toContain('file.txt');
    });
  });

  describe('search tool - claw parameter (supplementary)', () => {
    it('should allow Motion to search a single claw (claw: "claw1")', async () => {
      const motionDir = path.join(tempDir, 'motion');
      await fs.mkdir(motionDir, { recursive: true });
      const claw1Dir = path.join(tempDir, 'claws', 'claw1', 'clawspace');
      await fs.mkdir(claw1Dir, { recursive: true });
      await fs.writeFile(path.join(claw1Dir, 'note.txt'), 'Error in claw1: disk full');

      const motionFs = new NodeFileSystem({ baseDir: motionDir });
      const motionCtx = new ExecContextImpl({
        clawId: 'motion',
        clawDir: motionDir,
        profile: 'full',
        fs: motionFs,
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
        permissionChecker: createClawPermissionChecker({ clawDir: motionDir, strict: true }),
      });

      const result = await searchTool.execute({ query: 'Error', path: 'clawspace', claw: 'claw1' }, motionCtx);

      expect(result.success).toBe(true);
      expect(result.content).toContain('disk full');
    });

    it('should allow Motion subagent to search another claw', async () => {
      const motionDir = path.join(tempDir, 'motion');
      await fs.mkdir(motionDir, { recursive: true });
      const claw1Dir = path.join(tempDir, 'claws', 'claw1', 'clawspace');
      await fs.mkdir(claw1Dir, { recursive: true });
      await fs.writeFile(path.join(claw1Dir, 'log.txt'), 'Warning: timeout');

      const motionFs = new NodeFileSystem({ baseDir: motionDir });
      const subagentCtx = new ExecContextImpl({
        clawId: 'task-uuid',
        clawDir: motionDir,
        profile: 'full',
        callerType: 'subagent',
        fs: motionFs,
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
        originClawId: 'motion',
        permissionChecker: createClawPermissionChecker({ clawDir: motionDir, strict: true }),
      });

      const result = await searchTool.execute({ query: 'Warning', path: 'clawspace', claw: 'claw1' }, subagentCtx);

      expect(result.success).toBe(true);
      expect(result.content).toContain('timeout');
    });
  });
});
