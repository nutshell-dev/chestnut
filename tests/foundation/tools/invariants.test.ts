import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
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
import { DEFAULT_TOOL_TIMEOUT_MS, createToolExecutor } from '../../../src/foundation/tools/index.js';
import { createDoneTool } from '../../../src/core/subagent/tools/done.js';
import { createSubmitSubtaskTool } from '../../../src/core/contract/tools/submit-subtask.js';
import { cloneExecContext } from '../../../src/foundation/tools/context.js';
import type { ExecContext } from '../../../src/foundation/tools/context.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Phase 963 r119 B fork — Profile advertise invariant lint test
 *
 * Invariant: every tool object has at least one profile.
 *
 * Catches NEW tool added to registry but missing profiles field.
 */
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

describe('phase 1027: DEFAULT_TOOL_TIMEOUT_MS L2 唯一 ownership', () => {
  it('exported from L2 foundation/tools (反向 1: L2 唯一 source)', () => {
    expect(DEFAULT_TOOL_TIMEOUT_MS).toBe(3_600_000);
  });

  it('ToolExecutor ctor default uses imported const (反向 2: 同模块单源)', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../../src/foundation/tools/executor.ts'),
      'utf8'
    );
    expect(src).toMatch(/defaultTimeoutMs\s*=\s*DEFAULT_TOOL_TIMEOUT_MS/);
    expect(src).not.toMatch(/defaultTimeoutMs\s*=\s*60000/);
  });

  it('L5 runtime/constants.ts 已删除 (反向 3: phase 1301 删空壳 / L5 不再持)', () => {
    const exists = fs.existsSync(
      path.resolve(__dirname, '../../../src/core/runtime/constants.ts'),
    );
    expect(exists).toBe(false);
  });
});

/**
 * Tool profiles business semantic boundary test (phase 947 M#2 align)
 */
describe('Tool profiles DONE_TOOL_NAME business semantic boundary (phase 947 M#2 align)', () => {
  it('full profile does not contain DONE_TOOL_NAME (main motion uses submit_subtask not done)', () => {
    const doneTool = createDoneTool();
    expect(doneTool.profiles).not.toContain('full');
  });

  it('subagent profile still contains DONE_TOOL_NAME (subagent hard-stop protocol)', () => {
    const doneTool = createDoneTool();
    expect(doneTool.profiles).toContain('subagent');
  });

  it('SUBMIT_SUBTASK_TOOL_NAME is in full profile (main motion uses contract flow)', () => {
    const submitSubtaskTool = createSubmitSubtaskTool({} as any);
    expect(submitSubtaskTool.profiles).toContain('full');
  });
});

describe('cloneExecContext stopRequested getter fallback (phase 929)', () => {
  it('plain object mock without stopRequested field → cloned getter returns false (not undefined)', () => {
    // Arrange: plain object mock 缺 stopRequested + requestStop (mimic phase 815 P1.32 fixture defense)
    const fixture = {
      clawId: 'test',
      // 故意省略 stopRequested + requestStop fields
    } as unknown as ExecContext;

    // Act
    const clone = cloneExecContext(fixture);

    // Assert: getter returns false (not undefined)
    expect(clone.stopRequested).toBe(false);
    expect(typeof clone.stopRequested).toBe('boolean');
  });

  it('真 ExecContextImpl ctx stopRequested=false → cloned getter returns false (unchanged behavior)', () => {
    const realCtx = {
      clawId: 'test',
      stopRequested: false,
      requestStop: () => {},
    } as unknown as ExecContext;
    const clone = cloneExecContext(realCtx);
    expect(clone.stopRequested).toBe(false);
  });

  it('真 ctx stopRequested=true → cloned getter returns true (unchanged behavior)', () => {
    const realCtx = {
      clawId: 'test',
      stopRequested: true,
      requestStop: () => {},
    } as unknown as ExecContext;
    const clone = cloneExecContext(realCtx);
    expect(clone.stopRequested).toBe(true);
  });

  it('setter through clone mutates parent ctx (phase 778 invariant unchanged)', () => {
    const realCtx = {
      clawId: 'test',
      stopRequested: false,
      requestStop: () => {},
    } as unknown as ExecContext & { stopRequested: boolean };
    const clone = cloneExecContext(realCtx);
    (clone as ExecContext & { stopRequested: boolean }).stopRequested = true;
    expect(realCtx.stopRequested).toBe(true);
  });
});
