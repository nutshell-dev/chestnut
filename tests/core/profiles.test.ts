/**
 * Tool profiles tests
 */
import { describe, it, expect } from 'vitest';
import { readTool } from '../../src/foundation/file-tool/read.js';
import { writeTool } from '../../src/foundation/file-tool/write.js';
import { editTool } from '../../src/foundation/file-tool/edit.js';
import { multiEditTool } from '../../src/foundation/file-tool/multi_edit.js';
import { spawnTool } from '../../src/core/spawn-system/tools/spawn.js';
import { createShadowTool } from '../../src/core/shadow-system/tools/shadow.js';
import { memorySearchTool } from '../../src/core/memory/tools/memory_search.js';
import { execTool } from '../../src/foundation/command-tool/exec.js';

describe('Tool Profiles', () => {
  it('should have correct tools in each profile', () => {
    // full profile tools
    expect(readTool.profiles).toContain('full');
    expect(spawnTool.profiles).toContain('full');
    expect(createShadowTool({ getTurnSnapshot: () => ({}) }).profiles).toContain('full');
    expect(execTool.profiles).toContain('full');

    // readonly constraints
    expect(writeTool.profiles).not.toContain('readonly');
    expect(spawnTool.profiles).not.toContain('readonly');
    expect(createShadowTool({ getTurnSnapshot: () => ({}) }).profiles).not.toContain('readonly');

    // subagent constraints
    expect(spawnTool.profiles).not.toContain('subagent');
    expect(createShadowTool({ getTurnSnapshot: () => ({}) }).profiles).not.toContain('subagent');

    // edit / multi_edit in subagent + miner but not readonly
    expect(editTool.profiles).toContain('subagent');
    expect(editTool.profiles).toContain('miner');
    expect(editTool.profiles).not.toContain('readonly');
    expect(multiEditTool.profiles).toContain('subagent');
    expect(multiEditTool.profiles).toContain('miner');
    expect(multiEditTool.profiles).not.toContain('readonly');

    // memory_search in readonly
    expect(memorySearchTool.profiles).toContain('readonly');
  });
});
