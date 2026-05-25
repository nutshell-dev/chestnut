/**
 * test.extend fixture for tests/core/task.test.ts (phase 1256 concurrent refactor)
 *
 * Each test gets isolated tempDir + AsyncTaskSystem instance. Supports reassignment
 * via replaceTaskSystem() for tests that need custom mockLLM / audit setups.
 */
import { test as base } from 'vitest';
import { NodeFileSystem } from '../../src/foundation/fs/index.js';
import { ToolRegistryImpl } from '../../src/foundation/tools/registry.js';
import { AsyncTaskSystem } from '../../src/core/async-task-system/system.js';
import { createTempDir, cleanupTempDir } from '../utils/temp.js';
import { makeAudit } from './audit.js';
import { createTestTaskSystem } from './task-system.js';

export interface TaskTestCtx {
  readonly tempDir: string;
  readonly mockFs: NodeFileSystem;
  readonly registry: ToolRegistryImpl;
  readonly taskSystem: AsyncTaskSystem;
  replaceTaskSystem(newSys: AsyncTaskSystem): void;
}

export const test = base.extend<{ ctx: TaskTestCtx }>({
  ctx: async ({}, use) => {
    const tempDir = await createTempDir();
    const mockFs = new NodeFileSystem({ baseDir: tempDir });
    await mockFs.ensureDir('tasks');
    let currentSystem = createTestTaskSystem(tempDir, mockFs, makeAudit().audit);
    await currentSystem.initialize();
    currentSystem.startDispatch();
    const registry = new ToolRegistryImpl();

    const ctx: TaskTestCtx = {
      tempDir,
      mockFs,
      registry,
      get taskSystem() { return currentSystem; },
      replaceTaskSystem(newSys: AsyncTaskSystem) { currentSystem = newSys; },
    };

    await use(ctx);

    await currentSystem.shutdown(1000);
    await cleanupTempDir(tempDir);
  },
});
