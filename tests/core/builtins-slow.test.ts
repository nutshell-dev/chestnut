/**
 * Builtins slow outliers (phase 1252 split from builtins.test.ts)
 *
 * ls pagination tests — 101 writes, stays in fast project.
 * Phase 1069: exec timeout test moved to tests/foundation/command-tool/exec-timeout.integration.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';

import { lsTool } from '../../src/foundation/file-tool/index.js';
import { createClawPermissionChecker } from '../../src/core/permissions/claw-permissions.js';
import { ExecContextImpl } from '../../src/foundation/tools/context.js';
import { NodeFileSystem } from '../../src/foundation/fs/index.js';
import { createOutboxWriter, type OutboxWriter } from '../../src/foundation/messaging/index.js';
import { makeAudit } from '../helpers/audit.js';
import { createTempDir, cleanupTempDir } from '../utils/temp.js';

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
      // phase 223: parallelize 101 writes (was sequential ~900ms → batched ~50ms)
      await Promise.all(
        Array.from({ length: 101 }, (_, i) => mockFs.writeAtomic(`clawspace/file${i}.txt`, ''))
      );

      const result = await lsTool.execute({ path: '.' }, ctx);

      expect(result.success).toBe(true);
      // Should show pagination indicator
      expect(result.content).toContain('entries total');
      expect(result.content).toContain('101');
    });

    it('should limit output to 100 entries', async () => {
      // phase 223: parallelize 101 writes (was sequential ~900ms → batched ~50ms)
      await Promise.all(
        Array.from({ length: 101 }, (_, i) => mockFs.writeAtomic(`clawspace/file${i}.txt`, ''))
      );

      const result = await lsTool.execute({ path: '.' }, ctx);

      expect(result.success).toBe(true);
      const lines = result.content.split('\n').filter(l => l.trim() && !l.includes('...'));
      // Should have 100 entries plus possibly pagination line
      const fileLines = lines.filter(l => l.includes('[FILE]') || l.includes('[DIR]'));
      expect(fileLines.length).toBeLessThanOrEqual(100);
    });
  });

});
