/**
 * Builtins slow outliers (phase 1252 split from builtins.test.ts)
 *
 * 3 slow tests separated to enable file-level parallel run with the fast subset.
 * Pattern: phase 1252 cluster #3 / file split for parallel.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';

import { lsTool } from '../../src/foundation/file-tool/index.js';
import { execTool } from '../../src/foundation/command-tool/index.js';
import { createClawPermissionChecker } from '../../src/core/permissions/claw-permissions.js';
import { ExecContextImpl } from '../../src/foundation/tools/context.js';
import { NodeFileSystem } from '../../src/foundation/fs/index.js';
import { OutboxWriter } from '../../src/foundation/messaging/index.js';
import { createOutboxWriter } from '../../src/foundation/messaging/index.js';
import { makeAudit } from '../helpers/audit.js';
import { createTempDir, cleanupTempDir } from '../utils/temp.js';

// phase 1353: removed dead vi.mock(AsyncTaskSystem.schedule) — mockWriteFile never used in tests
// file mock-free → moves to fast project

describe('Builtin Tools (slow outliers)', () => {
  let tempDir: string;
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
  });

  describe('ls tool', () => {
    it('should show pagination indicator when more than 100 files', async () => {
      // Create 101 files
      for (let i = 0; i < 101; i++) {
        await mockFs.writeAtomic(`clawspace/file${i}.txt`, '');
      }

      const result = await lsTool.execute({ path: '.' }, ctx);

      expect(result.success).toBe(true);
      // Should show pagination indicator
      expect(result.content).toContain('entries total');
      expect(result.content).toContain('101');
    });

    it('should limit output to 100 entries', async () => {
      // Create 101 files
      for (let i = 0; i < 101; i++) {
        await mockFs.writeAtomic(`clawspace/file${i}.txt`, '');
      }

      const result = await lsTool.execute({ path: '.' }, ctx);

      expect(result.success).toBe(true);
      const lines = result.content.split('\n').filter(l => l.trim() && !l.includes('...'));
      // Should have 100 entries plus possibly pagination line
      const fileLines = lines.filter(l => l.includes('[FILE]') || l.includes('[DIR]'));
      expect(fileLines.length).toBeLessThanOrEqual(100);
    });
  });

  describe('exec tool', () => {
    it('should fail with timeout error when timeoutMs exceeded', async () => {
      // sleep 5s with timeoutMs:100 → src clamp 把 100ms 拉到 PROCESS_EXEC_TIMEOUT_MIN_MS (1000ms)
      // 但 clamp 后 1000ms 仍远小于 sleep 5000ms / timeout 必先 fire / 不 race
      // 旧版用 sleep 1 与 clamp 后 1000ms 同长 / CI 慢机器 sleep 完成早于 timeout / race condition
      // 真合规 src 改方向：clamp 时 emit audit warning（推 phase 743+）
      const result = await execTool.execute({ command: 'sleep 5', timeoutMs: 100 }, ctx);
      expect(result.success).toBe(false);
      expect(result.content).toMatch(/timed out|timeout|超时/i);
    });
  });
});
