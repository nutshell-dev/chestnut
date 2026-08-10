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
