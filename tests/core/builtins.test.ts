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
import { makeClawforumRoot } from '../../src/foundation/identity/index.js';
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
      clawforumRoot: makeClawforumRoot(tempDir),
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

    it('should record FileState with isFullRead=true after non-truncated read', async () => {
      await mockFs.ensureDir('clawspace');
      await mockFs.writeAtomic('clawspace/small.txt', 'small content');

      await readTool.execute({ path: 'small.txt' }, ctx);

      const state = ctx.readFileState.get('clawspace/small.txt');
      expect(state).toBeDefined();
      expect(state?.isFullRead).toBe(true);
    });

    // phase 1430: offset alone still triggers 200-line cap from offset (not "to EOF")
    it('offset-only on big file still caps at READ_DEFAULT_LINES from offset', async () => {
      await mockFs.ensureDir('clawspace');
      const lines = Array.from({ length: 500 }, (_, i) => `Line ${i + 1}`);
      await mockFs.writeAtomic('clawspace/big.txt', lines.join('\n'));

      // offset alone — must NOT return lines 100→500 (300 lines); must cap at 200 from offset
      const result = await readTool.execute({ path: 'big.txt', offset: 100 }, ctx);

      expect(result.success).toBe(true);
      const returnedLines = result.content.split('\n').filter(l => l.startsWith('Line '));
      expect(returnedLines.length).toBe(200);
      expect(returnedLines[0]).toBe('Line 100');
      expect(returnedLines[199]).toBe('Line 299');
      expect(result.content).toContain('Showing lines 100-299 of 500');
      // offset alone is rangeRequested → never full-read
      const state = ctx.readFileState.get('clawspace/big.txt');
      expect(state?.isFullRead).toBe(false);
    });

    // phase 1430: explicit limit overrides the 200-line default
    it('limit overrides READ_DEFAULT_LINES — claw decides scope', async () => {
      await mockFs.ensureDir('clawspace');
      const lines = Array.from({ length: 500 }, (_, i) => `Line ${i + 1}`);
      await mockFs.writeAtomic('clawspace/big.txt', lines.join('\n'));

      const result = await readTool.execute({ path: 'big.txt', limit: 400 }, ctx);

      expect(result.success).toBe(true);
      const returnedLines = result.content.split('\n').filter(l => l.startsWith('Line '));
      expect(returnedLines.length).toBe(400);
      // limit=400 only covers lines 1-400 of 500 → did NOT see all lines → isFullRead=false
      const state = ctx.readFileState.get('clawspace/big.txt');
      expect(state?.isFullRead).toBe(false);
    });

    // phase 1444: explicit limit that covers every current line qualifies as full-read
    // (semantic 已与 "no offset/limit" 解耦：trust signal 是 "agent actually saw all lines"、
    // 不是 "agent didn't pass range params"。)
    it('phase 1444: limit >= totalLines qualifies isFullRead=true', async () => {
      await mockFs.ensureDir('clawspace');
      await mockFs.writeAtomic('clawspace/tiny.txt', 'a\nb\nc');

      await readTool.execute({ path: 'tiny.txt', limit: 999 }, ctx);

      const state = ctx.readFileState.get('clawspace/tiny.txt');
      expect(state?.isFullRead).toBe(true);
    });

    it('phase 1444: limit equal to totalLines qualifies isFullRead=true', async () => {
      await mockFs.ensureDir('clawspace');
      const lines = Array.from({ length: 500 }, (_, i) => `Line ${i + 1}`);
      await mockFs.writeAtomic('clawspace/exact.txt', lines.join('\n'));

      await readTool.execute({ path: 'exact.txt', limit: 500 }, ctx);

      const state = ctx.readFileState.get('clawspace/exact.txt');
      expect(state?.isFullRead).toBe(true);
    });

    it('phase 1444: offset > 1 disqualifies even if limit covers rest', async () => {
      await mockFs.ensureDir('clawspace');
      const lines = Array.from({ length: 10 }, (_, i) => `Line ${i + 1}`);
      await mockFs.writeAtomic('clawspace/offset.txt', lines.join('\n'));

      // offset=2 means agent skipped line 1 → not full-read
      await readTool.execute({ path: 'offset.txt', offset: 2, limit: 100 }, ctx);

      const state = ctx.readFileState.get('clawspace/offset.txt');
      expect(state?.isFullRead).toBe(false);
    });

    it('phase 1444: offset=1 + limit covering rest qualifies isFullRead=true', async () => {
      await mockFs.ensureDir('clawspace');
      const lines = Array.from({ length: 10 }, (_, i) => `Line ${i + 1}`);
      await mockFs.writeAtomic('clawspace/exact-from1.txt', lines.join('\n'));

      await readTool.execute({ path: 'exact-from1.txt', offset: 1, limit: 100 }, ctx);

      const state = ctx.readFileState.get('clawspace/exact-from1.txt');
      expect(state?.isFullRead).toBe(true);
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

    // phase 1430: 300 行文件 + 不传 limit → 截到 200 行、isFullRead=false
    it('should cap at READ_DEFAULT_LINES (200) when no limit is set and file exceeds default', async () => {
      await mockFs.ensureDir('clawspace');
      const lines = Array.from({ length: 300 }, (_, i) => `Line ${i + 1}`);
      await mockFs.writeAtomic('clawspace/large.txt', lines.join('\n'));

      const result = await readTool.execute({ path: 'large.txt' }, ctx);

      expect(result.success).toBe(true);
      expect(result.content).toContain('Showing lines 1-200 of 300');
      const state = ctx.readFileState.get('clawspace/large.txt');
      expect(state).toBeDefined();
      expect(state?.isFullRead).toBe(false);
    });

    // phase 1430: byte cap (100KB) → overflow saved to disk + head/tail returned
    it('should persist to overflow file when output exceeds READ_OUTPUT_HARD_CAP_BYTES (100 KB)', async () => {
      await mockFs.ensureDir('clawspace');
      // Build content > 100 KB so byte cap triggers (lines must be ≤ 200 to avoid line cap first)
      const longLine = 'x'.repeat(2000);
      const content = Array.from({ length: 60 }, () => longLine).join('\n');  // ~120 KB / 60 lines
      await mockFs.writeAtomic('clawspace/huge.txt', content);

      const result = await readTool.execute({ path: 'huge.txt' }, ctx);

      expect(result.success).toBe(true);
      expect(result.content).toMatch(/Full output \(\d+ bytes\) saved/);
      expect(result.content).toContain('tasks/sync/read/');
      // gate must reject overwrite since byte cap triggered
      const state = ctx.readFileState.get('clawspace/huge.txt');
      expect(state?.isFullRead).toBe(false);
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
      expect(result.content).toContain('not been fully read');
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

    // phase 1430: externally modified file rejects overwrite with stale message
    it('should reject overwrite when file was externally modified since last read', async () => {
      await mockFs.ensureDir('clawspace');
      await mockFs.writeAtomic('clawspace/stale.txt', 'v1 content');

      // claw read it (qualifies as full read)
      await readTool.execute({ path: 'stale.txt' }, ctx);

      // external process modifies the file (advance mtime + change content)
      await new Promise(r => setTimeout(r, 15));
      const fsNative = await import('fs');
      fsNative.writeFileSync(path.join(tempDir, 'clawspace/stale.txt'), 'v2 external content');

      const writeResult = await writeTool.execute({
        path: 'stale.txt',
        content: 'v3 claw content',
      }, ctx);

      expect(writeResult.success).toBe(false);
      expect(writeResult.content).toMatch(/modified since/);
    });

    // phase 1430: partial-range read never qualifies as full-read (silent X 治理)
    it('partial-range read does NOT enable overwrite gate', async () => {
      await mockFs.ensureDir('clawspace');
      const big = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`).join('\n');
      await mockFs.writeAtomic('clawspace/partial.txt', big);

      // claw reads only first 10 lines (explicit limit → partial)
      await readTool.execute({ path: 'partial.txt', offset: 1, limit: 10 }, ctx);

      const writeResult = await writeTool.execute({
        path: 'partial.txt',
        content: 'truncated rewrite',
      }, ctx);

      expect(writeResult.success).toBe(false);
      expect(writeResult.content).toMatch(/not been fully read/);
    });

    // phase 1437: edit/multi_edit 不能 unconditionally 升 isFullRead=true
    // ——claw 工具内部 read 全文是私事、claw 视角仍是 partial / 未读

    it('phase 1437: edit on never-read file does NOT enable overwrite (silent X 治理)', async () => {
      await mockFs.ensureDir('clawspace');
      await mockFs.writeAtomic('clawspace/edit-gate.txt', 'foo bar baz');

      // claw 不 read、直接 edit
      const editResult = await editTool.execute({
        path: 'edit-gate.txt',
        oldText: 'bar',
        newText: 'qux',
      }, ctx);
      expect(editResult.success).toBe(true);

      // 后续 overwrite 必须仍被拒（claw 视角从未看过全文）
      const writeResult = await writeTool.execute({
        path: 'edit-gate.txt',
        content: 'totally new',
      }, ctx);
      expect(writeResult.success).toBe(false);
      expect(writeResult.content).toMatch(/not been fully read/);

      const state = ctx.readFileState.get('clawspace/edit-gate.txt');
      expect(state?.isFullRead).toBe(false);
    });

    it('phase 1437: edit after partial-range read does NOT enable overwrite', async () => {
      await mockFs.ensureDir('clawspace');
      const big = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`).join('\n');
      await mockFs.writeAtomic('clawspace/partial-edit.txt', big);

      // partial read (lines 50-60 only)
      await readTool.execute({ path: 'partial-edit.txt', offset: 50, limit: 10 }, ctx);
      // edit something in that range
      await editTool.execute({
        path: 'partial-edit.txt',
        oldText: 'Line 55',
        newText: 'Line FIFTY-FIVE',
      }, ctx);

      // overwrite must still be rejected
      const writeResult = await writeTool.execute({
        path: 'partial-edit.txt',
        content: 'wipe',
      }, ctx);
      expect(writeResult.success).toBe(false);
      expect(writeResult.content).toMatch(/not been fully read/);
    });

    it('phase 1437: edit after full read preserves isFullRead=true (allows subsequent overwrite)', async () => {
      await mockFs.ensureDir('clawspace');
      await mockFs.writeAtomic('clawspace/full-edit.txt', 'alpha beta gamma');

      // full read first
      await readTool.execute({ path: 'full-edit.txt' }, ctx);
      // edit
      await editTool.execute({
        path: 'full-edit.txt',
        oldText: 'beta',
        newText: 'BETA',
      }, ctx);

      // overwrite should pass — claw knew full content + made explicit edit
      const writeResult = await writeTool.execute({
        path: 'full-edit.txt',
        content: 'replacement based on full knowledge',
      }, ctx);
      expect(writeResult.success).toBe(true);
    });

    it('phase 1437: multi_edit mirrors edit semantics — no full-read promotion', async () => {
      await mockFs.ensureDir('clawspace');
      await mockFs.writeAtomic('clawspace/multi-gate.txt', 'a b c d');

      // claw 不 read、直接 multi_edit
      const multiResult = await multiEditTool.execute({
        path: 'multi-gate.txt',
        edits: [
          { oldText: 'a', newText: 'A' },
          { oldText: 'b', newText: 'B' },
        ],
      }, ctx);
      expect(multiResult.success).toBe(true);

      // overwrite 仍拒
      const writeResult = await writeTool.execute({
        path: 'multi-gate.txt',
        content: 'replaced',
      }, ctx);
      expect(writeResult.success).toBe(false);
      expect(writeResult.content).toMatch(/not been fully read/);
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

      const result = await editTool.execute({ path: 'edit.txt', oldText: 'hello', newText: 'hi' }, ctx);

      expect(result.success).toBe(true);
      expect(result.content).toContain('Edited:');
      expect(result.metadata).toEqual({ replaced: 1 });
      const content = await mockFs.read('clawspace/edit.txt');
      expect(content).toBe('hi world');
    });

    it('should fail loud on 0 match', async () => {
      await mockFs.ensureDir('clawspace');
      await mockFs.writeAtomic('clawspace/edit.txt', 'hello world');

      const result = await editTool.execute({ path: 'edit.txt', oldText: 'notfound', newText: 'x' }, ctx);

      expect(result.success).toBe(false);
      expect(result.content).toContain('0 matches');
    });

    it('should fail loud on multiple matches without replaceAll', async () => {
      await mockFs.ensureDir('clawspace');
      await mockFs.writeAtomic('clawspace/edit.txt', 'foo bar foo');

      const result = await editTool.execute({ path: 'edit.txt', oldText: 'foo', newText: 'qux' }, ctx);

      expect(result.success).toBe(false);
      expect(result.content).toContain('2 matches');
    });

    it('should reject when file does not exist', async () => {
      const result = await editTool.execute({ path: 'nonexistent.txt', oldText: 'a', newText: 'b' }, ctx);
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
          { oldText: 'a', newText: 'x' },
          { oldText: 'c', newText: 'y' },
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
          { oldText: 'hello', newText: 'hi' },
          { oldText: 'notfound', newText: 'x' },
        ],
      }, ctx);

      expect(result.success).toBe(false);
      expect(result.content).toContain('edit[1]');
      expect(result.metadata).toEqual({ failed_index: 1, results: [{ index: 0, replaced: 1, line: 1 }] });
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

      const result = await searchTool.execute({ text: 'hello' }, ctx);

      expect(result.success).toBe(true);
      expect(result.content).toContain('[Content matches]');
      expect(result.content).toContain('Hello world');
      expect(result.content).toContain('Hello again');
      expect(result.content).not.toContain('Goodbye');
    });

    it('should return no results message', async () => {
      await mockFs.ensureDir('clawspace');
      await mockFs.writeAtomic('clawspace/empty.txt', 'Nothing here');

      const result = await searchTool.execute({ text: 'xyz' }, ctx);

      expect(result.success).toBe(true);
      expect(result.content).toBe('No matches for "xyz".');
    });

    it('should reject claw="*" for non-Motion (broadcast still Motion-only)', async () => {
      const result = await searchTool.execute({ text: 'test', path: 'clawspace', claw: '*' }, ctx);

      expect(result.success).toBe(false);
      expect(result.content).toContain('Motion-only');
    });

    it('should allow specific claw target for non-Motion (D11 align)', async () => {
      const mainClawDir = path.join(tempDir, 'claws', 'main-claw');
      await fs.mkdir(mainClawDir, { recursive: true });
      const otherClawDir = path.join(tempDir, 'claws', 'other-claw', 'clawspace');
      await fs.mkdir(otherClawDir, { recursive: true });
      await fs.writeFile(path.join(otherClawDir, 'note.txt'), 'cross-claw content');

      const mainCtx = new ExecContextImpl({
        clawforumRoot: makeClawforumRoot(tempDir),
        clawId: 'main-claw',
        clawDir: mainClawDir,
        syncDir: path.join(mainClawDir, 'tasks/sync'),
        profile: 'full',
        fs: mockFs,
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
        permissionChecker: createClawPermissionChecker({ clawDir: mainClawDir, strict: true }),
      });
      const result = await searchTool.execute({ text: 'cross-claw', path: 'clawspace', claw: 'other-claw' }, mainCtx);

      expect(result.success).toBe(true);
      expect(result.content).toContain('[other-claw]');
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
        clawforumRoot: makeClawforumRoot(tempDir),
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

      const result = await searchTool.execute({ text: 'error', path: 'clawspace/', claw: '*' }, motionCtx);

      expect(result.success).toBe(true);
      // Results should have [clawId] prefix
      expect(result.content).toContain('[claw1]');
      expect(result.content).toContain('[claw2]');
      expect(result.content).toContain('disk full');
      expect(result.content).toContain('timeout');
      // Format: [clawId] clawspace/file.txt with line: content on next line (segmented)
      expect(result.content).toMatch(/\[claw1\] clawspace\/note\.txt/);
      expect(result.content).toMatch(/\[claw2\] clawspace\/log\.txt/);
    });

    it('should return no results when no claws directory exists (claw: "*")', async () => {
      // Create Motion context with a clawDir whose parent doesn't exist
      const nonExistentDir = path.join(tempDir, 'nonexistent', 'motion');
      const motionFs = new NodeFileSystem({ baseDir: nonExistentDir });
      const motionOutboxWriter = createOutboxWriter('motion', nonExistentDir, motionFs);
      const motionCtx = new ExecContextImpl({
        clawforumRoot: makeClawforumRoot(tempDir),
        clawId: 'motion',
        clawDir: nonExistentDir,
        profile: 'full',
        fs: motionFs,
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
        outboxWriter: motionOutboxWriter,
        permissionChecker: createClawPermissionChecker({ clawDir: nonExistentDir, strict: true }),
      });

      const result = await searchTool.execute({ text: 'test', path: 'clawspace/', claw: '*' }, motionCtx);

      expect(result.success).toBe(true);
      expect(result.content).toBe('No matches for "test".');
    });

    it('should aggregate matches across multiple claws with claw: "*"', async () => {
      const motionDir = path.join(tempDir, 'motion');
      await fs.mkdir(motionDir, { recursive: true });

      const motionFs = new NodeFileSystem({ baseDir: motionDir });
      const motionOutboxWriter = createOutboxWriter('motion', motionDir, motionFs, makeAudit().audit);
      const motionCtx = new ExecContextImpl({
        clawforumRoot: makeClawforumRoot(tempDir),
        clawId: 'motion',
        clawDir: motionDir,
        profile: 'full',
        fs: motionFs,
        fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
        outboxWriter: motionOutboxWriter,
        permissionChecker: createClawPermissionChecker({ clawDir: motionDir, strict: true }),
      });

      const clawsDir = path.join(tempDir, 'claws');

      const claw1Dir = path.join(clawsDir, 'claw1', 'clawspace');
      await fs.mkdir(claw1Dir, { recursive: true });
      await fs.writeFile(path.join(claw1Dir, 'many.txt'), 'target\ntarget\ntarget');

      const claw2Dir = path.join(clawsDir, 'claw2', 'clawspace');
      await fs.mkdir(claw2Dir, { recursive: true });
      await fs.writeFile(path.join(claw2Dir, 'many.txt'), 'target\ntarget\ntarget');

      const result = await searchTool.execute({ text: 'target', path: 'clawspace/', claw: '*' }, motionCtx);

      expect(result.success).toBe(true);
      // 6 content matches total (3 per claw × 2 claws) — under preview limit 20, full return
      const claw1Count = (result.content.match(/\[claw1\]/g) || []).length;
      const claw2Count = (result.content.match(/\[claw2\]/g) || []).length;
      expect(claw1Count).toBeGreaterThan(0);
      expect(claw2Count).toBeGreaterThan(0);
    });

    // M2 fix: claw="*" search returns results in stable alphabetical order
    it('should return results in alphabetical claw order (M2)', async () => {
      const motionDir = path.join(tempDir, 'motion');
      await fs.mkdir(motionDir, { recursive: true });

      const motionFs = new NodeFileSystem({ baseDir: motionDir });
      const motionOutboxWriter = createOutboxWriter('motion', motionDir, motionFs, makeAudit().audit);
      const motionCtx = new ExecContextImpl({
        clawforumRoot: makeClawforumRoot(tempDir),
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

      const result = await searchTool.execute({ text: 'match', path: 'clawspace/', claw: '*' }, motionCtx);

      expect(result.success).toBe(true);
      // a_claw should appear before m_claw before z_claw in the output (stable alphabetical order)
      const aPos = result.content.indexOf('[a_claw]');
      const mPos = result.content.indexOf('[m_claw]');
      const zPos = result.content.indexOf('[z_claw]');
      expect(aPos).toBeGreaterThan(-1);
      expect(mPos).toBeGreaterThan(aPos);
      expect(zPos).toBeGreaterThan(mPos);
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
    it('non-existent command (sh exits 127): agent 语义信号、success:true + [exit 127]', async () => {
      // phase 1417: `sh -c nonexistent_command_xyz` → sh 进程 spawn 成功、shell 找不到命令 → exit 127。
      // sh ran 完成了 tool 契约、127 是 sh 的标准「command not found」语义信号、agent 自己解读。
      // 对比真 spawn-error（sh 本身找不到）走 isRealFailure 分支 → success:false。
      const result = await execTool.execute({ command: 'nonexistent_command_xyz' }, ctx);

      expect(result.success).toBe(true);
      expect(result.content).toMatch(/^\[exit 127\]/);
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

    // phase 1417: exit ≠ 0 是 agent 语义信号、不是工具失败 → success:true + content 头带 [exit N]
    it('exit non-zero with stderr: success:true + content 头带 [exit N] + stderr 原文', async () => {
      const result = await execTool.execute(
        { command: "sh -c 'echo \"stderr output\" >&2; exit 1'" },
        ctx,
      );

      expect(result.success).toBe(true);
      expect(result.content).toMatch(/^\[exit 1\]/);
      expect(result.content).toContain('stderr output');
    });

    it('exit non-zero with stdout: success:true + content 头带 [exit N] + stdout 原文', async () => {
      const result = await execTool.execute(
        { command: "sh -c 'echo \"stdout output\"; exit 1'" },
        ctx,
      );

      expect(result.success).toBe(true);
      expect(result.content).toMatch(/^\[exit 1\]/);
      expect(result.content).toContain('stdout output');
    });

    it('grep no match (exit 1) 是 agent 语义信号、不是工具失败：success:true', async () => {
      // grep 无匹配 → exit 1、stdout 空。这是 grep 表达「找不到」的标准 POSIX 语义。
      const result = await execTool.execute(
        { command: "echo 'haystack' | grep 'needle'" },
        ctx,
      );

      expect(result.success).toBe(true);
      expect(result.content).toMatch(/^\[exit 1\]/);
    });

    it('abort signal 已触发时命令被取消，返回 success:false', async () => {
      const controller = new AbortController();
      controller.abort(); // 预先 abort

      const abortCtx = new ExecContextImpl({
        clawforumRoot: makeClawforumRoot(tempDir),
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

    it('exit non-zero 结果不暴露绝对路径（claw 心智 workspace-relative）', async () => {
      const result = await execTool.execute(
        { command: "sh -c 'exit 1'" },
        ctx,
      );

      // phase 1417: 纯非零退出 = agent 语义信号 = success:true，content 头带 [exit N]
      expect(result.success).toBe(true);
      expect(result.content).toMatch(/^\[exit 1\]/);
      // cwdHint 已删 — content 不应携带 [cwd] 标记或绝对 clawDir
      expect(result.content).not.toContain('[cwd]:');
      expect(result.content).not.toContain(ctx.clawDir);
    });

    it('clawDir 不存在时返回 ENOENT 错误（success:false）', async () => {
      const missingDirCtx = new ExecContextImpl({
        clawforumRoot: makeClawforumRoot(path.join(path.join(tempDir, 'nonexistent-dir-xyz'), "..")),
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
        clawforumRoot: makeClawforumRoot(tempDir),
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
        clawforumRoot: makeClawforumRoot(tempDir),
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
        { path: '../tasks/subagents/phase518-test/temp.txt', content: 'data' },
        subagentCtx,
      );

      expect(result.success).toBe(true);
      expect(fsNative.existsSync(path.join(subagentTempDir, 'temp.txt'))).toBe(true);
    });

    it('subagent default write 落 clawspace (与 caller 共享)', async () => {
      const fsNative = await import('fs');
      fsNative.mkdirSync(path.join(tempDir, 'clawspace'), { recursive: true });
      const subagentCtx = new ExecContextImpl({
        clawforumRoot: makeClawforumRoot(tempDir),
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
        clawforumRoot: makeClawforumRoot(tempDir),
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
        clawforumRoot: makeClawforumRoot(tempDir),
        clawId: 'motion',
        clawDir: motionDir,
        profile: 'full',
        fs: motionFs,
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
        permissionChecker: createClawPermissionChecker({ clawDir: motionDir, strict: true }),
      });

      const result = await readTool.execute({ path: 'test.txt', claw: 'claw1' }, motionCtx);

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
        clawforumRoot: makeClawforumRoot(tempDir),
        clawId: 'task-uuid-123',
        clawDir: motionDir,
        profile: 'full',
        callerType: 'subagent',
        fs: motionFs,
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
        originClawId: 'motion',
        permissionChecker: createClawPermissionChecker({ clawDir: motionDir, strict: true }),
      });

      const result = await readTool.execute({ path: 'note.txt', claw: 'claw1' }, subagentCtx);

      expect(result.success).toBe(true);
      expect(result.content).toBe('Note from claw1');
    });

    it('should allow specific claw target for non-Motion (D11 align)', async () => {
      const mainClawDir = path.join(tempDir, 'claws', 'main-claw');
      await fs.mkdir(mainClawDir, { recursive: true });
      const claw1Dir = path.join(tempDir, 'claws', 'claw1', 'clawspace');
      await fs.mkdir(claw1Dir, { recursive: true });
      await fs.writeFile(path.join(claw1Dir, 'note.txt'), 'Note from claw1');

      const mainCtx = new ExecContextImpl({
        clawforumRoot: makeClawforumRoot(tempDir),
        clawId: 'main-claw',
        clawDir: mainClawDir,
        syncDir: path.join(mainClawDir, 'tasks/sync'),
        profile: 'full',
        fs: mockFs,
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
        permissionChecker: createClawPermissionChecker({ clawDir: mainClawDir, strict: true }),
      });
      const result = await readTool.execute({ path: 'note.txt', claw: 'claw1' }, mainCtx);

      expect(result.success).toBe(true);
      expect(result.content).toBe('Note from claw1');
    });

    it('should reject invalid claw ID (path traversal)', async () => {
      const motionDir = path.join(tempDir, 'motion');
      await fs.mkdir(motionDir, { recursive: true });
      const motionFs = new NodeFileSystem({ baseDir: motionDir });
      const motionCtx = new ExecContextImpl({
        clawforumRoot: makeClawforumRoot(tempDir),
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
        clawforumRoot: makeClawforumRoot(tempDir),
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
        clawforumRoot: makeClawforumRoot(tempDir),
        clawId: 'motion',
        clawDir: motionDir,
        profile: 'full',
        fs: motionFs,
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
        permissionChecker: createClawPermissionChecker({ clawDir: motionDir, strict: true }),
      });

      // "../c11/secret.md" from clawspace resolves to <clawDir>/c11/secret.md (within claw).
      // NodeFileSystem.read blocks "../" prefix as base directory escape.
      const result = await readTool.execute({ path: '../c11/secret.md', claw: 'c1' }, motionCtx);

      expect(result.success).toBe(false);
      expect(result.content).toMatch(/attempts to escape claw root/);
    });

    it('allows cross-claw read when targetPath equals clawRoot (path="")', async () => {
      const motionDir = path.join(tempDir, 'motion');
      await fs.mkdir(motionDir, { recursive: true });
      const c1Dir = path.join(tempDir, 'claws', 'c1', 'clawspace');
      await fs.mkdir(c1Dir, { recursive: true });
      await fs.writeFile(path.join(c1Dir, 'note.md'), 'note content');

      const motionFs = new NodeFileSystem({ baseDir: motionDir });
      const motionCtx = new ExecContextImpl({
        clawforumRoot: makeClawforumRoot(tempDir),
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
      expect(result.content).not.toMatch(/Path escapes target claw root/);
    });

    it('cross-claw read does NOT pollute caller readFileState (write gate intact)', async () => {
      const motionDir = path.join(tempDir, 'motion');
      await fs.mkdir(motionDir, { recursive: true });
      const motionFs = new NodeFileSystem({ baseDir: motionDir });
      const motionCtx = new ExecContextImpl({
        clawforumRoot: makeClawforumRoot(tempDir),
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
      const readResult = await readTool.execute({ path: 'foo.md', claw: 'c1' }, motionCtx);
      expect(readResult.success).toBe(true);

      // Create a local file that motion same-claw write 'foo.md' resolves to
      const localFile = path.join(motionDir, 'clawspace', 'foo.md');
      await fs.mkdir(path.dirname(localFile), { recursive: true });
      await fs.writeFile(localFile, 'local content');

      // Same-claw write to 'foo.md' (resolves to clawspace/foo.md) should still be rejected
      // because cross-claw read must not add to same-claw write gate
      const writeResult = await writeTool.execute({
        path: 'foo.md',
        content: 'attack',
      }, motionCtx);

      expect(writeResult.success).toBe(false);
      expect(writeResult.content).toMatch(/not been fully read/i);
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
        clawforumRoot: makeClawforumRoot(tempDir),
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
        clawforumRoot: makeClawforumRoot(tempDir),
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
      const mainClawDir = path.join(tempDir, 'claws', 'main-claw');
      await fs.mkdir(mainClawDir, { recursive: true });
      const claw1Dir = path.join(tempDir, 'claws', 'claw1', 'clawspace');
      await fs.mkdir(claw1Dir, { recursive: true });
      await fs.writeFile(path.join(claw1Dir, 'file.txt'), 'content');

      const mainCtx = new ExecContextImpl({
        clawforumRoot: makeClawforumRoot(tempDir),
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
        clawforumRoot: makeClawforumRoot(tempDir),
        clawId: 'motion',
        clawDir: motionDir,
        profile: 'full',
        fs: motionFs,
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
        permissionChecker: createClawPermissionChecker({ clawDir: motionDir, strict: true }),
      });

      const result = await searchTool.execute({ text: 'Error', path: 'clawspace', claw: 'claw1' }, motionCtx);

      expect(result.success).toBe(true);
      expect(result.content).toContain('[claw1]');
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
        clawforumRoot: makeClawforumRoot(tempDir),
        clawId: 'task-uuid',
        clawDir: motionDir,
        profile: 'full',
        callerType: 'subagent',
        fs: motionFs,
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
        originClawId: 'motion',
        permissionChecker: createClawPermissionChecker({ clawDir: motionDir, strict: true }),
      });

      const result = await searchTool.execute({ text: 'Warning', path: 'clawspace', claw: 'claw1' }, subagentCtx);

      expect(result.success).toBe(true);
      expect(result.content).toContain('[claw1]');
      expect(result.content).toContain('timeout');
    });
  });
});
