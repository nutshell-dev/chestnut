/**
 * Phase 963 r119 B fork — Profile advertise invariant lint test
 *
 * Invariant: every tool object has at least one profile.
 *
 * Catches NEW tool added to registry but missing profiles field.
 */
import { describe, it, expect } from 'vitest';
import { readTool } from '../../../src/foundation/file-tool/read.js';
import { writeTool } from '../../../src/foundation/file-tool/write.js';
import { searchTool } from '../../../src/foundation/file-tool/search.js';
import { lsTool } from '../../../src/foundation/file-tool/ls.js';
import { editTool } from '../../../src/foundation/file-tool/edit.js';
import { multiEditTool } from '../../../src/foundation/file-tool/multi_edit.js';
import { execTool } from '../../../src/foundation/command-tool/exec.js';
import { spawnTool } from '../../../src/core/spawn-system/tools/spawn.js';
import { createShadowTool } from '../../../src/core/shadow-system/tools/shadow.js';
import { memorySearchTool } from '../../../src/core/memory/tools/memory_search.js';
import type { Tool } from '../../../src/foundation/tools/types.js';

describe('phase 963 — profile advertise invariant lint', () => {
  const allTools: Tool[] = [
    readTool,
    writeTool,
    searchTool,
    lsTool,
    editTool,
    multiEditTool,
    execTool,
    spawnTool,
    createShadowTool({ getTurnSnapshot: () => ({}) }),
    memorySearchTool,
  ];

  it('every tool has at least one profile entry', () => {
    for (const tool of allTools) {
      expect(tool.profiles.length, `tool ${tool.name} has no profiles`).toBeGreaterThan(0);
    }
  });
});
