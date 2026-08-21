/**
 * spawn invariants — mechanical merge of the following source files
 * (no assertion logic changed):
 *  - spawn-di-restrictions.test.ts
 *  - spawn-tool-description.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { promises as fsPromises } from 'fs';
import { createSpawnTool } from '../../../src/core/spawn-system/index.js';
import { spawnTool } from '../../../src/core/spawn-system/tools/spawn.js';
import { ExecContextImpl } from '../../../src/foundation/tools/context.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { TASKS_QUEUES_PENDING_DIR } from '../../../src/core/async-task-system/index.js';
import { createMockTaskSystem } from '../../helpers/task-system.js';
import { makeAudit } from '../../helpers/audit.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';

describe('spawn-di-restrictions', () => {
  /**
   * Phase 807 DI restrictions for spawn tool.
   *
   * Verifies:
   * - createSpawnTool({ allowAsync: false }) rejects async spawn from shadow context.
   */

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
});

describe('spawn-tool-description', () => {
  /**
   * spawn-tool description accuracy
   * - phase 883 B2: must NOT contain stale "default: 100" claim
   * - phase 1490: must NOT leak DEFAULT_MAX_STEPS const value to LLM docs / must mention "inherits caller's main loop maxSteps"
   */

  describe('spawn-tool maxSteps description', () => {
    it('description mentions caller-inherits default (phase 1490)', () => {
      const desc = (spawnTool.schema.properties as any).maxSteps.description;
      expect(desc).toContain("inherits caller's main loop maxSteps");
    });

    it('description does NOT leak DEFAULT_MAX_STEPS const value (phase 1490 / no info leak to LLM docs)', () => {
      const desc = (spawnTool.schema.properties as any).maxSteps.description;
      expect(desc).not.toContain('DEFAULT_MAX_STEPS');
    });

    it('description does NOT contain stale "default: 100" claim (phase 883 B2)', () => {
      const desc = (spawnTool.schema.properties as any).maxSteps.description;
      expect(desc).not.toContain('default: 100');
    });
  });
});


describe('phase 1479 Step B: spawn async schedule 不写 mainContextSnapshot', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it('marker 条件具足（clawId + currentToolUseId）时 scheduled task 仍不含 mainContextSnapshot', async () => {
    const fs = new NodeFileSystem({ baseDir: tempDir });
    const audit = makeAudit();
    const tool = createSpawnTool({ taskSystem: createMockTaskSystem(fs, audit.audit) });
    const ctx = new ExecContextImpl({
      clawId: 'test-claw',
      clawDir: tempDir,
      syncDir: path.join(tempDir, 'tasks', 'sync'),
      profile: 'full',
      fs,
      auditWriter: audit.audit,
      currentToolUseId: 'tu-phase1479' as never,
    });

    const result = await tool.execute({ intent: 'async task', async: true }, ctx);
    expect(result.success).toBe(true);

    const pendingDir = path.join(tempDir, TASKS_QUEUES_PENDING_DIR);
    const files = (await fsPromises.readdir(pendingDir)).filter(f => f.endsWith('.json'));
    expect(files).toHaveLength(1);
    const task = JSON.parse(await fsPromises.readFile(path.join(pendingDir, files[0]), 'utf-8'));
    expect(task.mainContextSnapshot).toBeUndefined();
  });
});
