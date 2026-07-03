/**
 * Phase 807 DI restrictions for spawn tool.
 *
 * Verifies:
 * - createSpawnTool({ allowAsync: false }) rejects async spawn from shadow context.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { createSpawnTool } from '../../../src/core/spawn-system/index.js';
import { ExecContextImpl } from '../../../src/foundation/tools/context.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { makeAudit } from '../../helpers/audit.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';

describe('spawn DI restrictions (phase 807)', () => {
  let tempDir: string;
  let fs: NodeFileSystem;
  let audit: ReturnType<typeof makeAudit>;
  let baseCtx: ExecContextImpl;

  beforeEach(async () => {
    tempDir = await createTempDir();
    fs = new NodeFileSystem({ baseDir: tempDir });
    audit = makeAudit();
    baseCtx = new ExecContextImpl({
      clawId: 'test-claw',
      clawDir: tempDir,
      syncDir: path.join(tempDir, 'tasks', 'sync'),
      profile: 'full',
      fs,
      auditWriter: audit.audit,
    });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it('shadow context (allowAsync: false) rejects async spawn', async () => {
    const restrictedSpawnTool = createSpawnTool({ allowAsync: false });

    const result = await restrictedSpawnTool.execute(
      { intent: 'shadow async task', async: true },
      baseCtx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('shadow_async_spawn_rejected');
  });
});
