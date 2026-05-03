/**
 * ToolExecutor: ctx prototype preservation across spread
 *
 * End-to-end tests verifying that ExecContext class methods/getters
 * survive the ToolExecutor.execute() spread path.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ToolExecutor } from '../../src/core/tools/executor.js';
import { ExecContextImpl } from '../../src/core/tools/context.js';
import { statusTool } from '../../src/core/tools/builtins/index.js';
import { readTool, lsTool, searchTool } from '../../src/foundation/file-tool/index.js';
import { ToolRegistryImpl } from '../../src/core/tools/registry.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { makeAudit } from '../helpers/audit.js';
import { MOTION_CLAW_ID } from '../../src/constants.js';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

describe('ToolExecutor: ctx prototype preservation across spread', () => {
  let tmpDir: string;
  let fs: NodeFileSystem;
  let executor: ToolExecutor;
  let registry: ToolRegistryImpl;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'phase332-'));
    fs = new NodeFileSystem({ baseDir: tmpDir });
    registry = new ToolRegistryImpl();
    registry.register(statusTool);
    registry.register(readTool);
    registry.register(lsTool);
    registry.register(searchTool);
    executor = new ToolExecutor({ registry, clawDir: tmpDir, fs });
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  function makeMotionCtx(): ExecContextImpl {
    return new ExecContextImpl({
      clawId: MOTION_CLAW_ID,
      clawDir: tmpDir,
      profile: 'full',
      fs,
      auditWriter: makeAudit().audit,
    });
  }

  it('status: ctx.getElapsedMs survives ToolExecutor.execute spread', async () => {
    const ctx = makeMotionCtx();
    const result = await executor.execute({ toolName: 'status', args: {}, ctx });
    expect(result.success).toBe(true);
    expect(result.content).toMatch(/Elapsed:\s*\d+ms/);
  });

  it('read (motion chain): ctx.isMotionChain survives spread / cross-claw read NOT rejected', async () => {
    // Create target claw directory structure: ../claws/other-claw/clawspace/note.md
    const otherClawDir = path.join(tmpDir, '..', 'claws', 'other-claw', 'clawspace');
    await fsp.mkdir(otherClawDir, { recursive: true });
    await fsp.writeFile(path.join(otherClawDir, 'note.md'), 'cross-claw content');

    const ctx = makeMotionCtx();
    const result = await executor.execute({
      toolName: 'read',
      args: { path: 'clawspace/note.md', claw: 'other-claw' },
      ctx,
    });
    expect(result.success).toBe(true);
    expect(result.content).toContain('cross-claw content');
  });

  it('ls (motion chain): isMotionChain check passes (not rejected)', async () => {
    const otherClawDir = path.join(tmpDir, '..', 'claws', 'other-claw', 'clawspace');
    await fsp.mkdir(otherClawDir, { recursive: true });
    await fsp.writeFile(path.join(otherClawDir, 'file1.txt'), 'a');

    const ctx = makeMotionCtx();
    const result = await executor.execute({
      toolName: 'ls',
      args: { path: 'clawspace', claw: 'other-claw' },
      ctx,
    });
    expect(result.success).toBe(true);
    expect(result.content).toContain('file1.txt');
  });

  it('search (motion chain): isMotionChain check passes', async () => {
    const otherClawDir = path.join(tmpDir, '..', 'claws', 'other-claw', 'clawspace');
    await fsp.mkdir(otherClawDir, { recursive: true });
    await fsp.writeFile(path.join(otherClawDir, 'a.txt'), 'hello world');

    const ctx = makeMotionCtx();
    const result = await executor.execute({
      toolName: 'search',
      args: { query: 'hello', path: 'clawspace', claw: 'other-claw' },
      ctx,
    });
    expect(result.success).toBe(true);
  });

  it('non-motion claw: read cross-claw correctly rejected (regression guard)', async () => {
    const otherClawDir = path.join(tmpDir, '..', 'claws', 'other-claw', 'clawspace');
    await fsp.mkdir(otherClawDir, { recursive: true });
    await fsp.writeFile(path.join(otherClawDir, 'note.md'), 'x');

    const ctx = new ExecContextImpl({
      clawId: 'normal-claw',
      clawDir: tmpDir,
      profile: 'full',
      fs,
      auditWriter: makeAudit().audit,
    });
    const result = await executor.execute({
      toolName: 'read',
      args: { path: 'clawspace/note.md', claw: 'other-claw' },
      ctx,
    });
    expect(result.success).toBe(false);
    expect(result.content).toMatch(/motion|cross.?claw/i);
  });
});
