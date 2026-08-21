import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8');

describe('phase 1368: claw layout ownership boundary', () => {
  it('Assembly core infrastructure invokes the single owner action', () => {
    const layout = read('src/assembly/claw-subdirs.ts');
    const coreInfrastructure = read('src/assembly/core-infrastructure.ts');

    expect(layout).toContain('export function initializeClawLayout(');
    expect(coreInfrastructure).toContain("import { initializeClawLayout } from './claw-subdirs.js';");
    expect(coreInfrastructure).toContain('initializeClawLayout(systemFs);');
    expect(coreInfrastructure).not.toContain('TASKS_SYNC_DIR');
    expect(coreInfrastructure).not.toContain('const syncDir =');
  });

  it('Runtime neither observes nor executes the Assembly-owned directory set', () => {
    const assembly = read('src/assembly/runtime-assembly.ts');
    const types = read('src/core/runtime/types.ts');
    const runtime = read('src/core/runtime/runtime.ts');

    expect(assembly).not.toContain('CLAW_SUBDIRS');
    expect(assembly).not.toContain('clawSubdirs');
    expect(types).not.toContain('clawSubdirs');
    expect(runtime).not.toContain('clawSubdirs');
    expect(runtime).not.toContain('ensureDirectories');
  });

  it('CLI create continues to use the same Assembly owner action', () => {
    const barrel = read('src/assembly/index.ts');
    const clawCreate = read('src/cli/commands/claw-create.ts');

    expect(barrel).toContain("export { initializeClawLayout } from './claw-subdirs.js';");
    expect(clawCreate).toContain("import { initializeClawLayout } from '../../assembly/index.js';");
    expect(clawCreate).toContain('initializeClawLayout(fileSystem);');
  });
});

describe('phase 1488: TASKS_SYNC_DIR namespace name owned by ClawIdentity', () => {
  it('claw-files.ts defines TASKS_SYNC_DIR exactly once', () => {
    const src = read('src/foundation/claw-identity/claw-files.ts');
    const matches = src.match(/export\s+const\s+TASKS_SYNC_DIR\s+=\s+['"]tasks\/sync['"]/g);
    expect(matches).toHaveLength(1);
  });

  it('ClawIdentity barrel exports TASKS_SYNC_DIR', () => {
    const barrel = read('src/foundation/claw-identity/index.ts');
    expect(barrel).toContain('TASKS_SYNC_DIR');
  });

  it('AsyncTaskSystem dirs.ts and barrel no longer define or re-export TASKS_SYNC_DIR', () => {
    const dirs = read('src/core/async-task-system/dirs.ts');
    const barrel = read('src/core/async-task-system/index.ts');
    expect(dirs).not.toContain('TASKS_SYNC_DIR');
    expect(barrel).not.toContain('TASKS_SYNC_DIR');
  });

  it('Runtime and ContractSystem do not import TASKS_SYNC_DIR from async-task-system', () => {
    const runtime = read('src/core/runtime/runtime.ts');
    const verifier = read('src/core/contract/verifier-job.ts');
    expect(runtime).not.toMatch(/TASKS_SYNC_DIR.*async-task-system|async-task-system.*TASKS_SYNC_DIR/);
    expect(verifier).not.toMatch(/TASKS_SYNC_DIR.*async-task-system|async-task-system.*TASKS_SYNC_DIR/);
  });

  it('Spawn and Shadow use ctx.syncDir instead of TASKS_SYNC_DIR', () => {
    const spawn = read('src/core/spawn-system/system.ts');
    const shadow = read('src/core/shadow-system/system.ts');
    expect(spawn).not.toContain('TASKS_SYNC_DIR');
    expect(spawn).toContain('opts.ctx.syncDir');
    expect(shadow).not.toContain('TASKS_SYNC_DIR');
    expect(shadow).toContain('opts.ctx.syncDir');
  });
});

describe('phase 1489: tasks/sync/ snapshot ignore policy moved to Assembly', () => {
  it('AsyncTaskSystem TASK_SNAPSHOT_IGNORE source no longer contains tasks/sync/', () => {
    const dirs = read('src/core/async-task-system/dirs.ts');
    expect(dirs).not.toContain("'tasks/sync/'");
    expect(dirs).not.toContain('"tasks/sync/"');
  });

  it('Assembly snapshot-patterns imports TASKS_SYNC_DIR from ClawIdentity', () => {
    const patterns = read('src/assembly/config/snapshot-patterns.ts');
    expect(patterns).toContain('TASKS_SYNC_DIR');
    expect(patterns).toMatch(/import\s+\{[^}]*TASKS_SYNC_DIR[^}]*\}\s+from\s+['"]\.\.\/\.\.\/foundation\/claw-identity\/index\.js['"]/);
  });

  it('Assembly snapshot-patterns composes tasks/sync/ from TASKS_SYNC_DIR', () => {
    const patterns = read('src/assembly/config/snapshot-patterns.ts');
    expect(patterns).toContain('`${TASKS_SYNC_DIR}/`');
  });

  it('SNAPSHOT_IGNORE_PATTERNS contains tasks/sync/ exactly once', async () => {
    const { SNAPSHOT_IGNORE_PATTERNS } = await import('../../../src/assembly/config/snapshot-patterns.js');
    const matches = SNAPSHOT_IGNORE_PATTERNS.filter((p: string) => p === 'tasks/sync/');
    expect(matches).toHaveLength(1);
  });
});

describe('phase 1490: tasks/subagents/ snapshot ignore policy owned by SubAgent', () => {
  it('subagent/constants.ts derives SUBAGENT_SNAPSHOT_IGNORE from TASKS_SUBAGENTS_DIR', () => {
    const src = read('src/core/subagent/constants.ts');
    expect(src).toContain('SUBAGENT_SNAPSHOT_IGNORE');
    expect(src).toContain('TASKS_SUBAGENTS_DIR');
    expect(src).toContain('`${TASKS_SUBAGENTS_DIR}/`');
  });

  it('SubAgent barrel exports SUBAGENT_SNAPSHOT_IGNORE', () => {
    const barrel = read('src/core/subagent/index.ts');
    expect(barrel).toContain('SUBAGENT_SNAPSHOT_IGNORE');
  });

  it('AsyncTaskSystem dirs.ts no longer contains literal tasks/subagents/', () => {
    const dirs = read('src/core/async-task-system/dirs.ts');
    expect(dirs).not.toContain("'tasks/subagents/'");
    expect(dirs).not.toContain('"tasks/subagents/"');
  });

  it('Assembly snapshot-patterns imports and spreads SUBAGENT_SNAPSHOT_IGNORE', () => {
    const patterns = read('src/assembly/config/snapshot-patterns.ts');
    expect(patterns).toContain('SUBAGENT_SNAPSHOT_IGNORE');
    expect(patterns).toMatch(/import\s+\{[^}]*SUBAGENT_SNAPSHOT_IGNORE[^}]*\}\s+from\s+['"]\.\.\/\.\.\/core\/subagent\/index\.js['"]/);
    expect(patterns).toContain('...SUBAGENT_SNAPSHOT_IGNORE');
  });

  it('SNAPSHOT_IGNORE_PATTERNS contains tasks/subagents/ exactly once', async () => {
    const { SNAPSHOT_IGNORE_PATTERNS } = await import('../../../src/assembly/config/snapshot-patterns.js');
    const matches = SNAPSHOT_IGNORE_PATTERNS.filter((p: string) => p === 'tasks/subagents/');
    expect(matches).toHaveLength(1);
  });
});

describe('phase 1491: TASKS_SUBAGENTS_DIR namespace owned by SubAgent', () => {
  it('subagent/constants.ts defines TASKS_SUBAGENTS_DIR exactly once', () => {
    const src = read('src/core/subagent/constants.ts');
    const matches = src.match(/export\s+const\s+TASKS_SUBAGENTS_DIR\s+=\s+['"]tasks\/subagents['"]/g);
    expect(matches).toHaveLength(1);
  });

  it('SubAgent barrel exports TASKS_SUBAGENTS_DIR', () => {
    const barrel = read('src/core/subagent/index.ts');
    expect(barrel).toContain('TASKS_SUBAGENTS_DIR');
  });

  it('AsyncTaskSystem dirs.ts and barrel no longer contain TASKS_SUBAGENTS_DIR', () => {
    const dirs = read('src/core/async-task-system/dirs.ts');
    const barrel = read('src/core/async-task-system/index.ts');
    expect(dirs).not.toContain('TASKS_SUBAGENTS_DIR');
    expect(barrel).not.toContain('TASKS_SUBAGENTS_DIR');
  });

  it('Assembly, Permissions, and SubagentExecutor import TASKS_SUBAGENTS_DIR from SubAgent', () => {
    const layout = read('src/assembly/claw-subdirs.ts');
    const perms = read('src/core/permissions/claw-permissions.ts');
    const executor = read('src/core/async-task-system/subagent-executor.ts');
    expect(layout).toMatch(/import\s+\{[^}]*TASKS_SUBAGENTS_DIR[^}]*\}\s+from\s+['"]\.\.\/core\/subagent\/index\.js['"]/);
    expect(perms).toMatch(/import\s+\{[^}]*TASKS_SUBAGENTS_DIR[^}]*\}\s+from\s+['"]\.\.\/subagent\/index\.js['"]/);
    expect(executor).toMatch(/import\s+\{[^}]*TASKS_SUBAGENTS_DIR[^}]*\}\s+from\s+['"]\.\.\/subagent\/index\.js['"]/);
  });
});
