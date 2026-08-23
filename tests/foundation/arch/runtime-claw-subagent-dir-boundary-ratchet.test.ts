import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8');

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
