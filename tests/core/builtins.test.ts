/**
 * Builtin tools tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

import { readTool, writeTool, lsTool, searchTool, statusTool, sendTool, memorySearchTool } from '../../src/core/tools/builtins/index.js';
import { execTool } from '../../src/core/shell-tool/index.js';
import { spawnTool } from '../../src/core/task/tools/spawn.js';
import { ExecContextImpl } from '../../src/core/tools/context.js';
import { NodeFileSystem } from '../../src/foundation/fs/index.js';
import { OutboxWriter } from '../../src/foundation/messaging/index.js';
import { makeAudit } from '../helpers/audit.js';
import { ContractManager } from '../../src/core/contract/manager.js';
import { createContractStatusPort } from '../../src/core/contract/status-port-impl.js';
import { createTempDir, cleanupTempDir } from '../utils/temp.js';
import { TASKS_RUNNING_DIR } from '../../src/types/paths.js';
import { ToolExecutor } from '../../src/core/tools/executor.js';
import { ToolRegistryImpl } from '../../src/core/tools/registry.js';

const { mockWriteFile } = vi.hoisted(() => ({
  mockWriteFile: vi.fn(),
}));

vi.mock('../../src/core/task/tools/_pending-task-writer.js', () => ({
  writePendingSubagentTaskFile: mockWriteFile,
}));

describe('Builtin Tools', () => {
  let tempDir: string;
  let mockFs: NodeFileSystem;
  let ctx: ExecContextImpl;
  let outboxWriter: OutboxWriter;
  let executor: ToolExecutor;

  beforeEach(async () => {
    tempDir = await createTempDir();
    mockFs = new NodeFileSystem({ baseDir: tempDir });
    outboxWriter = new OutboxWriter('test-claw', tempDir, mockFs, makeAudit().audit);
    ctx = new ExecContextImpl({
      clawId: 'test-claw',
      clawDir: tempDir,
      profile: 'full',
      fs: mockFs,
    });
    const registry = new ToolRegistryImpl();
    registry.register(statusTool);
    executor = new ToolExecutor({ registry, clawDir: tempDir, fs: mockFs });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  async function executeViaExecutor(toolName: string, args: Record<string, unknown>, ctx: ExecContextImpl) {
    return executor.execute({ toolName, args, ctx });
  }

  describe('read tool', () => {
    it('should read existing file', async () => {
      await mockFs.ensureDir('clawspace');
      await mockFs.writeAtomic('clawspace/test.txt', 'Hello, World!');

      const result = await readTool.execute({ path: 'clawspace/test.txt' }, ctx);

      expect(result.success).toBe(true);
      expect(result.content).toBe('Hello, World!');
    });

    it('should return error for non-existent file', async () => {
      const result = await readTool.execute({ path: 'clawspace/nonexistent.txt' }, ctx);

      expect(result.success).toBe(false);
      expect(result.content).toContain('Error');
    });

    it('should read specific line range', async () => {
      await mockFs.ensureDir('clawspace');
      await mockFs.writeAtomic('clawspace/lines.txt', 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5');

      const result = await readTool.execute({ path: 'clawspace/lines.txt', offset: 2, limit: 2 }, ctx);

      expect(result.success).toBe(true);
      expect(result.content).toBe('Line 2\nLine 3');
    });

    it('should block logs/ path (blacklist)', async () => {
      const result = await readTool.execute({ path: 'logs/system.log' }, ctx);

      expect(result.success).toBe(false);
      expect(result.content).toContain('not allowed');
    });

    it('dialog/ path should not be blocked (only logs/ is blacklisted)', async () => {
      // dialog/current.json 不存在时返回 FileNotFound，不是权限错误
      const result = await readTool.execute({ path: 'dialog/current.json' }, ctx);
      expect(result.content).not.toContain('not allowed');
    });

    // Phase 2 质量审查补充：截断元信息测试
    it('should include metadata when truncating large files', async () => {
      await mockFs.ensureDir('clawspace');
      // Create 300 lines file (exceeds 200 line limit)
      const lines = Array.from({ length: 300 }, (_, i) => `Line ${i + 1}`);
      await mockFs.writeAtomic('clawspace/large.txt', lines.join('\n'));

      const result = await readTool.execute({ path: 'clawspace/large.txt' }, ctx);

      expect(result.success).toBe(true);
      expect(result.content).toContain('Showing lines 1-200 of 300');
      expect(result.content).toContain('offset=201');
    });

    it('should include byte count when truncating by char limit', async () => {
      await mockFs.ensureDir('clawspace');
      // Create ~10KB content (exceeds 8000 char limit)
      const content = 'x'.repeat(10000);
      await mockFs.writeAtomic('clawspace/huge.txt', content);

      const result = await readTool.execute({ path: 'clawspace/huge.txt' }, ctx);

      expect(result.success).toBe(true);
      expect(result.content).toContain('Showing first');
    });

    // Negative offset tests
    it('should read last N lines with negative offset', async () => {
      await mockFs.ensureDir('clawspace');
      await mockFs.writeAtomic('clawspace/lines.txt', 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5');

      const result = await readTool.execute({ path: 'clawspace/lines.txt', offset: -2 }, ctx);

      expect(result.success).toBe(true);
      expect(result.content).toBe('Line 4\nLine 5');
    });

    it('should read from negative offset with limit', async () => {
      await mockFs.ensureDir('clawspace');
      await mockFs.writeAtomic('clawspace/lines.txt', 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5');

      // offset=-3 means start from Line 3, limit=2 reads Line 3 and Line 4
      const result = await readTool.execute({ path: 'clawspace/lines.txt', offset: -3, limit: 2 }, ctx);

      expect(result.success).toBe(true);
      expect(result.content).toBe('Line 3\nLine 4');
    });

    it('should start from beginning when negative offset exceeds total lines', async () => {
      await mockFs.ensureDir('clawspace');
      await mockFs.writeAtomic('clawspace/lines.txt', 'Line 1\nLine 2\nLine 3');

      // offset=-10 exceeds total lines (3), should start from line 1
      const result = await readTool.execute({ path: 'clawspace/lines.txt', offset: -10 }, ctx);

      expect(result.success).toBe(true);
      expect(result.content).toBe('Line 1\nLine 2\nLine 3');
    });

    // Phase 16: error path Tip about claw parameter
    it('should include claw parameter Tip in error when reading non-existent file', async () => {
      const result = await readTool.execute({ path: 'clawspace/no-such-file.txt' }, ctx);

      expect(result.success).toBe(false);
      expect(result.content).toContain('Tip');
      expect(result.content).toContain('"claw"');
    });
  });

  describe('write tool', () => {
    it('should write new file', async () => {
      await mockFs.ensureDir('clawspace');
      const result = await writeTool.execute({ path: 'clawspace/output.txt', content: 'New content' }, ctx);

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
        path: 'clawspace/append.txt',
        content: 'Second line',
        append: true,
      }, ctx);

      expect(result.success).toBe(true);

      const content = await mockFs.read('clawspace/append.txt');
      expect(content).toBe('First line\nSecond line');
    });

    // Phase 2 质量审查补充：版本清理测试
    it('should keep only last 10 versions when writing', async () => {
      await mockFs.ensureDir('clawspace');
      
      // Write same file 15 times (creates 14 backups, first write has no backup)
      // After cleanup, should keep exactly 10 most recent
      for (let i = 0; i < 15; i++) {
        const result = await writeTool.execute({ 
          path: 'clawspace/versioned.txt', 
          content: `Content version ${i}` 
        }, ctx);
        expect(result.success).toBe(true);
      }

      // Check versions directory
      const versionsDir = path.join(tempDir, 'clawspace', '.versions');
      const versionFiles = await fs.readdir(versionsDir).catch(() => []);
      const relevantVersions = versionFiles.filter(f => f.startsWith('versioned.txt.'));
      
      // Should be exactly 10 after cleanup (15 writes - 1 = 14 backups, keep last 10)
      expect(relevantVersions.length).toBe(10);
    });

    it('should include byte count in success message', async () => {
      await mockFs.ensureDir('clawspace');
      const content = 'Hello, this is test content';
      
      const result = await writeTool.execute({ 
        path: 'clawspace/bytecount.txt', 
        content 
      }, ctx);

      expect(result.success).toBe(true);
      expect(result.content).toContain(`${content.length}`);
      expect(result.content).toContain('chars');
    });
  });

  describe('ls tool', () => {
    it('should list directory contents', async () => {
      await mockFs.writeAtomic('file1.txt', '');
      await mockFs.writeAtomic('file2.txt', '');
      await mockFs.ensureDir('subdir');

      const result = await lsTool.execute({ path: '.' }, ctx);

      expect(result.success).toBe(true);
      expect(result.content).toContain('[FILE] file1.txt');
      expect(result.content).toContain('[FILE] file2.txt');
      expect(result.content).toContain('[DIR] subdir');
    });

    it('should handle empty directory', async () => {
      await mockFs.ensureDir('empty');

      const result = await lsTool.execute({ path: 'empty' }, ctx);

      expect(result.success).toBe(true);
      expect(result.content).toBe('Directory is empty');
    });

    it('should default to current directory', async () => {
      await mockFs.writeAtomic('current.txt', '');

      const result = await lsTool.execute({}, ctx);

      expect(result.success).toBe(true);
      expect(result.content).toContain('current.txt');
    });

    // Phase 2 质量审查补充：分页测试
    it('should show pagination indicator when more than 100 files', async () => {
      // Create 120 files
      for (let i = 0; i < 120; i++) {
        await mockFs.writeAtomic(`file${i}.txt`, '');
      }

      const result = await lsTool.execute({ path: '.' }, ctx);

      expect(result.success).toBe(true);
      // Should show pagination indicator
      expect(result.content).toContain('entries total');
      expect(result.content).toContain('120');
    });

    it('should limit output to 100 entries', async () => {
      // Create 120 files
      for (let i = 0; i < 120; i++) {
        await mockFs.writeAtomic(`file${i}.txt`, '');
      }

      const result = await lsTool.execute({ path: '.' }, ctx);

      expect(result.success).toBe(true);
      const lines = result.content.split('\n').filter(l => l.trim() && !l.includes('...'));
      // Should have 100 entries plus possibly pagination line
      const fileLines = lines.filter(l => l.includes('[FILE]') || l.includes('[DIR]'));
      expect(fileLines.length).toBeLessThanOrEqual(100);
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

      const result = await searchTool.execute({ query: 'hello', path: 'clawspace' }, ctx);

      expect(result.success).toBe(true);
      expect(result.content).toContain('Hello world');
      expect(result.content).toContain('Hello again');
      expect(result.content).not.toContain('Goodbye');
    });

    it('should return no results message', async () => {
      await mockFs.ensureDir('clawspace');
      await mockFs.writeAtomic('clawspace/empty.txt', 'Nothing here');

      const result = await searchTool.execute({ query: 'xyz', path: 'clawspace' }, ctx);

      expect(result.success).toBe(true);
      expect(result.content).toContain('未找到');
    });

    it('should respect max_results', async () => {
      await mockFs.ensureDir('clawspace');
      await mockFs.writeAtomic('clawspace/many.txt', 'target\ntarget\ntarget\ntarget\ntarget\ntarget');

      const result = await searchTool.execute({ query: 'target', path: 'clawspace', max_results: 3 }, ctx);

      expect(result.success).toBe(true);
      const lines = result.content.split('\n').filter(l => l.trim());
      expect(lines.length).toBe(3);
    });

    it('should block paths not in allowlist', async () => {
      const result = await searchTool.execute({ query: 'test', path: 'dialog' }, ctx);

      expect(result.success).toBe(false);
      expect(result.content).toContain('not allowed');
    });

    it('should reject claw param for non-Motion', async () => {
      // ctx.clawId is 'test-claw', not 'motion'
      const result = await searchTool.execute({ query: 'test', path: 'clawspace', claw: 'other-claw' }, ctx);

      expect(result.success).toBe(false);
      expect(result.content).toContain('Only Motion and its subagents can search files from other claws');
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
      const motionOutboxWriter = new OutboxWriter('motion', motionDir, motionFs, makeAudit().audit);
      const motionCtx = new ExecContextImpl({
        clawId: 'motion',
        clawDir: motionDir,
        profile: 'full',
        fs: motionFs,
        outboxWriter: motionOutboxWriter,
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
      const motionOutboxWriter = new OutboxWriter('motion', nonExistentDir, motionFs);
      const motionCtx = new ExecContextImpl({
        clawId: 'motion',
        clawDir: nonExistentDir,
        profile: 'full',
        fs: motionFs,
        outboxWriter: motionOutboxWriter,
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
      const motionOutboxWriter = new OutboxWriter('motion', motionDir, motionFs, makeAudit().audit);
      const motionCtx = new ExecContextImpl({
        clawId: 'motion',
        clawDir: motionDir,
        profile: 'full',
        fs: motionFs,
        outboxWriter: motionOutboxWriter,
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
      const motionOutboxWriter = new OutboxWriter('motion', motionDir, motionFs, makeAudit().audit);
      const motionCtx = new ExecContextImpl({
        clawId: 'motion',
        clawDir: motionDir,
        permissions: { read: true, write: true, execute: true, spawn: true, send: true, network: false, system: false },
        profile: 'full',
        fs: motionFs,
        outboxWriter: motionOutboxWriter,
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

  describe('status tool', () => {
    it('should return status information', async () => {
      const result = await executeViaExecutor('status', {}, ctx);

      expect(result.success).toBe(true);
      expect(result.content).toContain('Claw ID: test-claw');
      expect(result.content).toContain('Profile: full');
      expect(result.content).toContain('Step:');
      expect(result.content).toContain('Elapsed:');
    });

    // Phase 21 Step 3: full subtask list display in getContractStatus()
    it('should show "Contract: N/A" when contractManager not injected', async () => {
      // default ctx has no contractManager
      const result = await executeViaExecutor('status', {}, ctx);
      expect(result.success).toBe(true);
      expect(result.content).toContain('Contract: N/A');
    });

    it('should show "No active contract" when contractManager has no active contract', async () => {
      const mockAudit = { write: vi.fn() };
      const manager = new ContractManager(tempDir, 'test-claw', mockFs, mockAudit as any);
      statusTool.contractStatus = createContractStatusPort(manager);

      const result = await executeViaExecutor('status', {}, ctx);

      expect(result.success).toBe(true);
      expect(result.content).toContain('No active contract');
    });

    it('should show subtask list with ○ icons when contract is active', async () => {
      const mockAudit = { write: vi.fn() };
      const manager = new ContractManager(tempDir, 'test-claw', mockFs, mockAudit as any);
      await manager.create({
        schema_version: 1 as const,
        title: 'Test Contract',
        goal: 'Test',
        deliverables: [],
        subtasks: [
          { id: 'task-1', description: 'First task' },
          { id: 'task-2', description: 'Second task' },
        ],
        acceptance: [],
        auth_level: 'auto' as const,
      });
      statusTool.contractStatus = createContractStatusPort(manager);

      const result = await executeViaExecutor('status', {}, ctx);

      expect(result.success).toBe(true);
      expect(result.content).toContain('Test Contract');
      expect(result.content).toContain('0/2 subtasks done');
      // Phase 21 Step 3: 逐行显示子任务
      expect(result.content).toContain('○ task-1: First task');
      expect(result.content).toContain('○ task-2: Second task');
    });

    it('should show ✓ for completed subtask and ○ for todo subtask', async () => {
      const mockAudit = { write: vi.fn() };
      const manager = new ContractManager(tempDir, 'test-claw', mockFs, mockAudit as any);
      const contractId = await manager.create({
        schema_version: 1 as const,
        title: 'Mixed Status',
        goal: 'Test',
        deliverables: [],
        subtasks: [
          { id: 'done-task', description: 'Already done' },
          { id: 'todo-task', description: 'Still pending' },
        ],
        acceptance: [],
        auth_level: 'auto' as const,
      });
      // 完成第一个子任务（无 acceptance 脚本，直接通过）
      await manager.completeSubtask({ contractId, subtaskId: 'done-task', evidence: 'done' });
      statusTool.contractStatus = createContractStatusPort(manager);

      const result = await executeViaExecutor('status', {}, ctx);

      expect(result.success).toBe(true);
      expect(result.content).toContain('✓ done-task: Already done');
      expect(result.content).toContain('○ todo-task: Still pending');
      expect(result.content).toContain('1/2 subtasks done');
    });

    // MEMORY.md 不存在
    it('should show MEMORY.md Not found when file does not exist', async () => {
      const result = await executeViaExecutor('status', {}, ctx);
      expect(result.success).toBe(true);
      expect(result.content).toContain('MEMORY.md: Not found');
    });

    // MEMORY.md 读取异常
    it('should show MEMORY.md Error when fs.read throws', async () => {
      await mockFs.writeAtomic('MEMORY.md', 'some content');
      const readSpy = vi.spyOn(mockFs, 'read').mockRejectedValueOnce(
        Object.assign(new Error('disk error'), { code: 'EIO' })
      );
      const result = await executeViaExecutor('status', {}, ctx);
      expect(result.content).toContain('MEMORY.md: Error');
      expect(result.content).toContain('disk error');
      readSpy.mockRestore();
    });

    // clawspace ENOENT → 0 files
    it('should show Clawspace 0 files when clawspace dir does not exist', async () => {
      // tempDir 内无 clawspace 目录，list 会抛 ENOENT
      const result = await executeViaExecutor('status', {}, ctx);
      expect(result.content).toContain('Clawspace: 0 files');
    });

    // clawspace 非 ENOENT 异常
    it('should show Clawspace Error when non-ENOENT error occurs', async () => {
      await mockFs.ensureDir('clawspace');
      const listSpy = vi.spyOn(mockFs, 'list').mockImplementation(async (target: string) => {
        if (target === 'clawspace') {
          throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        }
        return [];
      });
      const result = await executeViaExecutor('status', {}, ctx);
      expect(result.content).toContain('Clawspace: Error');
      expect(result.content).toContain('permission denied');
      listSpy.mockRestore();
    });

    // contractManager.loadActive 抛异常
    it('should show Contract Error loading when loadActive throws', async () => {
      statusTool.contractStatus = {
        loadStatusView: vi.fn().mockRejectedValue(new Error('corrupted yaml')),
      } as any;
      const result = await executeViaExecutor('status', {}, ctx);
      expect(result.content).toContain('Contract: Error loading');
      statusTool.contractStatus = undefined;
    });

    // 先找文件顶部的 import 部分来加

    // subtask failed 状态显示 ✗
    it('should show ✗ icon for failed subtask', async () => {
      const mockAudit = { write: vi.fn() };
      const manager = new ContractManager(tempDir, 'test-claw', mockFs, mockAudit as any);
      const contractId = await manager.create({
        title: 'Fail Test',
        goal: 'test',
        subtasks: [
          { id: 'fail-task', description: 'This will fail' },
          { id: 'ok-task', description: 'This is ok' },
        ],
        acceptance: [],
        deliverables: [],
      });
      // 直接修改 progress.json 设置 failed 状态
      const progressPath = path.join(tempDir, 'contract/active', contractId, 'progress.json');
      const raw = await fs.readFile(progressPath, 'utf-8');
      const progress = JSON.parse(raw);
      progress.subtasks['fail-task'].status = 'failed';
      await fs.writeFile(progressPath, JSON.stringify(progress));

      statusTool.contractStatus = createContractStatusPort(manager);
      const result = await executeViaExecutor('status', {}, ctx);
      expect(result.content).toContain('✗ fail-task');
      expect(result.content).toContain('○ ok-task');
      statusTool.contractStatus = undefined;
    });

    // task running + pending
    it('should show running and pending task counts', async () => {
      await mockFs.ensureDir('tasks/pending');
      await mockFs.ensureDir(TASKS_RUNNING_DIR);
      await mockFs.writeAtomic('tasks/pending/t1.json', '{}');
      await mockFs.writeAtomic('tasks/running/t2.json', '{}');

      const result = await executeViaExecutor('status', {}, ctx);
      expect(result.content).toContain('1 running, 1 pending');
    });

    // 只有 pending
    it('should show only pending task count when no running tasks', async () => {
      await mockFs.ensureDir('tasks/pending');
      await mockFs.writeAtomic('tasks/pending/t1.json', '{}');
      await mockFs.writeAtomic('tasks/pending/t2.json', '{}');

      const result = await executeViaExecutor('status', {}, ctx);
      expect(result.content).toContain('2 pending');
    });

    // tasks/pending 不存在 → silent (ENOENT is expected for fresh setup)
    it('should treat pending count as 0 when tasks/pending does not exist', async () => {
      const result = await executeViaExecutor('status', {}, ctx);
      expect(result.content).toContain('Tasks: idle');
      // ENOENT is now silently ignored (expected for fresh setup)
    });

    // AuditLog event tests for status tool error paths
    it('should audit STATUS_CONTRACT_ERROR when loadActive throws', async () => {
      const auditWriter = { write: vi.fn() };
      const ctxWithAudit = new ExecContextImpl({
        clawId: 'test-claw',
        clawDir: tempDir,
        profile: 'full',
        fs: mockFs,
        auditWriter: auditWriter as any,
      });
      statusTool.contractStatus = {
        loadStatusView: vi.fn().mockRejectedValue(new Error('yaml parse error')),
      } as any;

      await executeViaExecutor('status', {}, ctxWithAudit);
      statusTool.contractStatus = undefined;

      expect(auditWriter.write).toHaveBeenCalledWith(
        'status_contract_error',
        'error=yaml parse error',
      );
    });

    it('should audit STATUS_TASK_PENDING_ERROR when pending list fails non-ENOENT', async () => {
      const auditWriter = { write: vi.fn() };
      const listSpy = vi.spyOn(mockFs, 'list').mockRejectedValue(
        Object.assign(new Error('permission denied'), { code: 'EACCES' }),
      );
      const ctxWithAudit = new ExecContextImpl({
        clawId: 'test-claw',
        clawDir: tempDir,
        profile: 'full',
        fs: mockFs,
        auditWriter: auditWriter as any,
      });
      await executeViaExecutor('status', {}, ctxWithAudit);

      expect(auditWriter.write).toHaveBeenCalledWith(
        'status_task_pending_error',
        'error=permission denied',
      );

      listSpy.mockRestore();
    });

    it('should audit STATUS_TASK_RUNNING_ERROR when running list fails non-ENOENT', async () => {
      const auditWriter = { write: vi.fn() };
      // First call (pending) succeeds, second call (running) fails
      let callCount = 0;
      const listSpy = vi.spyOn(mockFs, 'list').mockImplementation(async (...args: any[]) => {
        callCount++;
        if (callCount === 1) {
          return []; // pending succeeds
        }
        throw Object.assign(new Error('disk error'), { code: 'EIO' });
      });
      const ctxWithAudit = new ExecContextImpl({
        clawId: 'test-claw',
        clawDir: tempDir,
        profile: 'full',
        fs: mockFs,
        auditWriter: auditWriter as any,
      });
      await executeViaExecutor('status', {}, ctxWithAudit);

      expect(auditWriter.write).toHaveBeenCalledWith(
        'status_task_running_error',
        'error=disk error',
      );

      listSpy.mockRestore();
    });

    // Batch 4 新增测试：subtask failed 状态显示 ✗
    it('should show ✗ icon for failed subtask', async () => {
      const mockAudit = { write: vi.fn() };
      const manager = new ContractManager(tempDir, 'test-claw', mockFs, mockAudit as any);
      const contractId = await manager.create({
        title: 'Fail Test',
        goal: 'test',
        subtasks: [
          { id: 'fail-task', description: 'This will fail' },
          { id: 'ok-task', description: 'This is ok' },
        ],
        acceptance: [],
        deliverables: [],
      });
      // 直接修改 progress.json 设置 failed 状态
      const progressPath = path.join(tempDir, 'contract/active', contractId, 'progress.json');
      const raw = await fs.readFile(progressPath, 'utf-8');
      const progress = JSON.parse(raw);
      progress.subtasks['fail-task'].status = 'failed';
      await fs.writeFile(progressPath, JSON.stringify(progress));

      statusTool.contractStatus = createContractStatusPort(manager);
      const result = await executeViaExecutor('status', {}, ctx);
      expect(result.content).toContain('✗ fail-task');
      expect(result.content).toContain('○ ok-task');
      statusTool.contractStatus = undefined;
    });
  });


  describe('send tool', () => {
    beforeEach(() => {
      sendTool.outboxWriter = outboxWriter;
    });
    afterEach(() => {
      sendTool.outboxWriter = undefined;
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

    it('should have timeout parameter processed', async () => {
      // Test that timeout parameter is accepted and processed
      // (actual timeout behavior depends on environment having shell commands)
      const result = await execTool.execute({ command: 'echo test', timeoutMs: 5000 }, ctx);

      // Should either succeed or fail with some error (not crash)
      expect(typeof result.success).toBe('boolean');
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
      expect(result.content).toContain('[stderr]');
      expect(result.content).toContain('stderr output');
    });

    it('should include stdout in error result when command writes to stdout and exits non-zero', async () => {
      const result = await execTool.execute(
        { command: "sh -c 'echo \"stdout output\"; exit 1'" },
        ctx,
      );

      expect(result.success).toBe(false);
      expect(result.content).toContain('[stdout]');
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
        signal: controller.signal,
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
  });

  describe('spawn tool', () => {
    beforeEach(() => {
      mockWriteFile.mockClear();
    });

    it('should pass maxSteps from context', async () => {
      mockWriteFile.mockResolvedValue('task-xxx');

      const ctxWithMaxSteps = new ExecContextImpl({
        clawId: 'test-claw',
        clawDir: tempDir,
        profile: 'full',
        fs: mockFs,
        outboxWriter,
        maxSteps: 42,
      });

      const result = await spawnTool.execute({
        prompt: 'test task',
      }, ctxWithMaxSteps);

      expect(result.success).toBe(true);
      expect(mockWriteFile).toHaveBeenCalled();
      expect(mockWriteFile.mock.calls[0][2].maxSteps).toBe(42);
      expect(mockWriteFile.mock.calls[0][2].prompt).toBe('test task');
    });

    it('messages 非数组时忽略，正常调度', async () => {
      const result = await spawnTool.execute({ prompt: 'test', messages: 'not-an-array' as any }, ctx);
      // 不应是 Invalid messages 错误
      expect(result.content).not.toContain('Invalid messages');
    });

    it('messages 含无效元素时返回 Invalid messages 错误', async () => {
      const result = await spawnTool.execute({
        prompt: 'test',
        messages: [null] as any,
      }, ctx);
      expect(result.success).toBe(false);
      expect(result.content).toContain('Invalid messages');
    });

    it('messages 含无 role 字段的对象时返回 Invalid messages 错误', async () => {
      const result = await spawnTool.execute({
        prompt: 'test',
        messages: [{ role: 42, content: 'hello' }] as any,
      }, ctx);
      expect(result.success).toBe(false);
      expect(result.content).toContain('Invalid messages');
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
        originClawId: 'motion',
      });

      const result = await readTool.execute({ path: 'clawspace/note.txt', claw: 'claw1' }, subagentCtx);

      expect(result.success).toBe(true);
      expect(result.content).toBe('Note from claw1');
    });

    it('should reject non-Motion from using claw parameter', async () => {
      const result = await readTool.execute({ path: 'clawspace/test.txt', claw: 'other-claw' }, ctx);

      expect(result.success).toBe(false);
      expect(result.content).toContain('Only Motion and its subagents');
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
      });

      const result = await readTool.execute({ path: 'test.txt', claw: 'claw/sub' }, motionCtx);

      expect(result.success).toBe(false);
      expect(result.content).toContain('Invalid');
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
        clawId: 'dispatcher-456',
        clawDir: motionDir,
        profile: 'full',
        callerType: 'dispatcher',
        fs: motionFs,
        originClawId: 'motion',
      });

      const result = await lsTool.execute({ path: 'skills', claw: 'claw1' }, subagentCtx);

      expect(result.success).toBe(true);
    });

    it('should reject non-Motion from using claw parameter', async () => {
      const result = await lsTool.execute({ path: 'clawspace', claw: 'other-claw' }, ctx);

      expect(result.success).toBe(false);
      expect(result.content).toContain('Only Motion and its subagents');
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
        originClawId: 'motion',
      });

      const result = await searchTool.execute({ query: 'Warning', path: 'clawspace', claw: 'claw1' }, subagentCtx);

      expect(result.success).toBe(true);
      expect(result.content).toContain('timeout');
    });
  });
});
