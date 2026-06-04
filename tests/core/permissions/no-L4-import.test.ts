/**
 * @module tests/core/permissions/no-L4-import
 * Phase 1335 sub-5: mechanical invariant — claw-permissions.ts 0 import from core/*-system/
 * Mirror phase 964+1019+1244+1265+1266+1277+1278+1324+1327+1332 invariant cluster N=11
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('claw-permissions no L4 import invariant', () => {
  it('claw-permissions.ts has 0 import from core/*-system/ or core/subagent/', async () => {
    const filePath = path.resolve(__dirname, '../../../src/core/permissions/claw-permissions.ts');
    const content = await fs.readFile(filePath, 'utf-8');

    const lines = content.split('\n');
    const violationLines = lines.filter(
      line => line.includes('from') && (
        line.includes("'../subagent/'") ||
        line.includes('"../subagent/"') ||
        line.includes("'../spawn-system/'") ||
        line.includes('"../spawn-system/"') ||
        line.includes("'../shadow-system/'") ||
        line.includes('"../shadow-system/"') ||
        line.includes("'../async-task-system/'") ||
        line.includes('"../async-task-system/"')
      )
    );

    expect(violationLines).toEqual([]);
  });

  it('taskSyncDirs injected at assembly time cascades to permission checks', async () => {
    const assemblePath = path.resolve(__dirname, '../../../src/assembly/assemble.ts');
    const businessPath = path.resolve(__dirname, '../../../src/assembly/business-systems.ts');
    const assembleContent = await fs.readFile(assemblePath, 'utf-8');
    const businessContent = await fs.readFile(businessPath, 'utf-8');
    const content = assembleContent + businessContent;

    expect(content).toContain('taskSyncDirs:');
    expect(content).toContain('TASKS_SYNC_SUBAGENT_DIR');
    expect(content).toContain('TASKS_SYNC_SPAWN_DIR');
    expect(content).toContain('TASKS_SYNC_SHADOW_DIR');
    expect(content).toContain('TASKS_SYNC_EXEC_DIR');
    expect(content).toContain('TASKS_SYNC_WRITE_DIR');
  });
});
