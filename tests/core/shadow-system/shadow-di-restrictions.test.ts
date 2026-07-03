/**
 * Phase 807 DI restrictions for shadow registry tools.
 *
 * Verifies:
 * - createShadowTool({ allowRecursion: false }) rejects recursive shadow calls
 * - createSpawnTool({ allowAsync: false }) rejects async spawn
 * - Shadow registry clones preserve main registry tool definitions (name/description/schema)
 *   for shadow/spawn/summon/notify-claw/exec tools.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { createShadowTool, SHADOW_TOOL_NAME } from '../../../src/core/shadow-system/index.js';
import { createSpawnTool, SPAWN_TOOL_NAME } from '../../../src/core/spawn-system/index.js';
import { SummonTool, SUMMON_TOOL_NAME } from '../../../src/core/summon-system/tools/summon.js';
import { createNotifyClawTool, NOTIFY_CLAW_TOOL_NAME } from '../../../src/core/claw-topology/tools/notify-claw.js';
import { createExecTool, EXEC_TOOL_NAME } from '../../../src/foundation/command-tool/index.js';
import { ToolRegistryImpl } from '../../../src/foundation/tools/registry.js';
import type { Tool, ToolRegistry } from '../../../src/foundation/tools/types.js';
import { ExecContextImpl } from '../../../src/foundation/tools/context.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { makeAudit } from '../../helpers/audit.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import type { Message, ToolDefinition } from '../../../src/foundation/llm-provider/types.js';

describe('shadow DI restrictions (phase 807)', () => {
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

  it('createShadowTool({ allowRecursion: false }) rejects recursive shadow calls', async () => {
    const restrictedShadowTool = createShadowTool({
      getTurnSnapshot: () => ({
        systemPrompt: 'sp',
        tools: [] as ToolDefinition[],
        messages: [] as Message[],
      }),
      allowRecursion: false,
    });

    const result = await restrictedShadowTool.execute({ task: 'recursive call' }, baseCtx);

    expect(result.success).toBe(false);
    expect(result.error).toBe('shadow_recursion_rejected');
  });

  it('createSpawnTool({ allowAsync: false }) rejects async spawn', async () => {
    const restrictedSpawnTool = createSpawnTool({ allowAsync: false });

    const result = await restrictedSpawnTool.execute({ intent: 'async task', async: true }, baseCtx);

    expect(result.success).toBe(false);
    expect(result.error).toBe('shadow_async_spawn_rejected');
  });

  it('shadow registry clones preserve main registry tool definitions', () => {
    const mainRegistry = new ToolRegistryImpl();
    mainRegistry.register(createShadowTool({
      getTurnSnapshot: () => ({ systemPrompt: 'sp', tools: [] as ToolDefinition[], messages: [] as Message[] }),
    }));
    mainRegistry.register(createSpawnTool());
    mainRegistry.register(new SummonTool());
    mainRegistry.register(createNotifyClawTool({
      fs,
      notifyClaw: vi.fn(),
      defaultSource: 'motion',
      audit: audit.audit,
      isClawAlive: () => true,
      formatClawStatusHint: () => undefined,
      clawExists: () => true,
      hasActiveContract: () => false,
    }));
    mainRegistry.register(createExecTool());

    const shadowRegistry = createRestrictedRegistry(mainRegistry, {
      [SHADOW_TOOL_NAME]: { allowRecursion: false },
      [SPAWN_TOOL_NAME]: { allowAsync: false },
      [SUMMON_TOOL_NAME]: { allowFromShadow: false },
      [NOTIFY_CLAW_TOOL_NAME]: { authorized: false },
      [EXEC_TOOL_NAME]: { callerType: 'shadow' },
    });

    for (const name of [SHADOW_TOOL_NAME, SPAWN_TOOL_NAME, SUMMON_TOOL_NAME, NOTIFY_CLAW_TOOL_NAME, EXEC_TOOL_NAME]) {
      const mainTool = mainRegistry.get(name);
      const shadowTool = shadowRegistry.get(name);
      expect(mainTool).toBeDefined();
      expect(shadowTool).toBeDefined();
      expect(shadowTool!.name).toBe(mainTool!.name);
      expect(shadowTool!.description).toBe(mainTool!.description);
      expect(shadowTool!.schema).toEqual(mainTool!.schema);
    }
  });
});

/**
 * Replicates the phase-807 shadow registry override logic: clone each base tool
 * into a fresh registry while overriding DI properties. Leaves ToolDefinition
 * (name/description/schema) unchanged so KV cache stays stable.
 */
function createRestrictedRegistry(
  baseRegistry: ToolRegistry,
  overridesByName: Record<string, Record<string, unknown>>,
): ToolRegistry {
  const registry = new ToolRegistryImpl();
  for (const tool of baseRegistry.getAll()) {
    const overrides = overridesByName[tool.name] ?? {};
    const restricted = Object.assign(Object.create(Object.getPrototypeOf(tool)), tool, overrides) as Tool;
    registry.register(restricted);
  }
  return registry;
}
