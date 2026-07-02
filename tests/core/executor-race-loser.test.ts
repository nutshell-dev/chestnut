/**
 * executor race-loser audit tests — phase 816 Step B2
 *
 * 验证 executionPromise race loser 时写入 tool_exec_race_loser audit row
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';

import { ToolExecutorImpl } from '../../src/foundation/tools/executor.js';
import { ToolRegistryImpl } from '../../src/foundation/tools/registry.js';
import { ExecContextImpl } from '../../src/foundation/tools/context.js';
import { NodeFileSystem } from '../../src/foundation/fs/index.js';
import { AuditWriter } from '../../src/foundation/audit/writer.js';
import { createTempDir, cleanupTempDir } from '../utils/temp.js';
import { waitFor } from '../helpers/wait-for.js';


describe('executor race-loser audit (phase 816 B2)', () => {
  let tempDir: string;
  let mockFs: NodeFileSystem;
  let ctx: ExecContextImpl;
  let registry: ToolRegistryImpl;
  let executor: ToolExecutorImpl;
  let auditWriter: AuditWriter;
  let slowToolRelease: (() => void) | undefined;

  beforeEach(async () => {
    tempDir = await createTempDir();
    mockFs = new NodeFileSystem({ baseDir: tempDir });
    auditWriter = new AuditWriter(mockFs, 'audit.tsv');
    ctx = new ExecContextImpl({
      clawId: 'test-claw',
      clawDir: tempDir,
      profile: 'full',
      fs: mockFs,
      auditWriter,
    });
    registry = new ToolRegistryImpl();
    executor = new ToolExecutorImpl(registry);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it('execution slow + timeout fast: winner audit ToolTimeoutError + loser audit real error', async () => {
    registry.register({
      name: 'slow-throw',
      description: 'slow then throw',
      schema: { type: 'object', properties: {}, required: [] },
      readonly: true,
      async execute(_args: Record<string, unknown>, toolCtx: any) {
        await new Promise<void>(r => {
          slowToolRelease = r;
          toolCtx.signal?.addEventListener('abort', () => r(), { once: true });
        }); // barrier: mock slow tool execution, auto-release on timeout signal
        throw new Error('real root cause');
      },
    });

    const result = await executor.execute({
      toolName: 'slow-throw',
      args: {},
      ctx,
      timeoutMs: 50,
    });

    expect(result.success).toBe(false);
    expect(result.content).toMatch(/timed out/);

    const auditPath = path.join(tempDir, 'audit.tsv');
    await waitFor(async () => {
      const content = await fs.readFile(auditPath, 'utf-8').catch(() => '');
      return content.includes('tool_exec_race_loser');
    }, 5000);

    const auditContent = await fs.readFile(auditPath, 'utf-8');
    const rows = auditContent.trim().split('\n');

    // winner row
    const winnerRow = rows.find(r => r.includes('tool_exec') && r.includes('slow-throw'));
    expect(winnerRow).toBeDefined();
    expect(winnerRow).toContain('err');
    expect(winnerRow).toContain('timed out');

    // loser row
    const loserRow = rows.find(r => r.includes('tool_exec_race_loser'));
    expect(loserRow).toBeDefined();
    expect(loserRow).toContain('slow-throw');
    expect(loserRow).toContain('context=execution_after_timeout');
    expect(loserRow).toContain('error=Error: real root cause');
  });

  it('execution fast (success): only winner audit, no loser row', async () => {
    registry.register({
      name: 'fast-ok',
      description: 'fast ok',
      schema: { type: 'object', properties: {}, required: [] },
      readonly: true,
      async execute() {
        return { success: true, content: 'ok' };
      },
    });

    const result = await executor.execute({
      toolName: 'fast-ok',
      args: {},
      ctx,
      timeoutMs: 5000,
    });

    expect(result.success).toBe(true);

    const auditPath = path.join(tempDir, 'audit.tsv');
    const auditContent = await fs.readFile(auditPath, 'utf-8');
    const rows = auditContent.trim().split('\n');

    const winnerRow = rows.find(r => r.includes('tool_exec') && r.includes('fast-ok'));
    expect(winnerRow).toBeDefined();
    expect(winnerRow).toContain('\tok\t');

    const loserRow = rows.find(r => r.includes('tool_exec_race_loser'));
    expect(loserRow).toBeUndefined();
  });
});
