import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { createExecTool } from '../../../src/foundation/command-tool/exec.js';
import { EXEC_MAX_OUTPUT } from '../../../src/foundation/command-tool/constants.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { assertWellFormedUnicode, truncateUtf8Prefix } from '../../../src/foundation/node-utils/utf8.js';
import { ProcessExecError } from '../../../src/foundation/process-exec/index.js';
import { makeExecContext } from '../../helpers/exec-context.js';
import { cleanupTempDir, createTempDir } from '../../utils/temp.js';

const { execMock } = vi.hoisted(() => ({ execMock: vi.fn() }));
vi.mock('../../../src/foundation/process-exec/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/foundation/process-exec/index.js')>();
  return { ...actual, exec: execMock };
});

describe('phase 2110 maxBuffer UTF-8 byte threshold', () => {
  let tempDir: string;
  let syncDir: string;

  beforeEach(async () => {
    execMock.mockReset();
    tempDir = await createTempDir();
    syncDir = path.join(tempDir, 'tasks', 'sync');
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  function makeContext() {
    const workspaceDir = path.join(tempDir, 'clawspace');
    return makeExecContext({
      clawDir: tempDir,
      workspaceDir,
      syncDir,
      fs: new NodeFileSystem({ baseDir: tempDir }),
    });
  }

  it('2001B but only 667 UTF-16 code units persists full output and stays failed', async () => {
    const output = '中'.repeat(667);
    execMock.mockRejectedValueOnce(new ProcessExecError({
      message: 'synthetic max buffer exceeded',
      output,
      exitCode: null,
      killed: true,
      maxBufferExceeded: true,
    }));

    const result = await createExecTool().execute({ command: 'unused' }, makeContext());

    expect(result.success).toBe(false);
    expect(result.content).toContain('Full output (2001 bytes) saved.');
    expect(result.content).not.toContain('[partial output]:');
    expect(Buffer.byteLength(result.content, 'utf8')).toBeLessThanOrEqual(EXEC_MAX_OUTPUT);
    expect(result.metadata?.output?.artifact).toMatchObject({ kind: 'durable' });
    const overflowDir = path.join(syncDir, 'exec');
    const files = await fs.promises.readdir(overflowDir);
    expect(files).toHaveLength(1);
    const artifact = await fs.promises.readFile(path.join(overflowDir, files[0]), 'utf8');
    expect(artifact.endsWith(output)).toBe(true);
  });

  it.each([
    { name: 'Chinese', output: '中'.repeat(1001) },
    { name: 'emoji', output: '😀'.repeat(501) },
  ])('maxBuffer persistence failure keeps a $name UTF-8-safe fallback without a fake path', async ({ output }) => {
    const ctx = makeContext();
    const write = vi.spyOn(ctx.fs, 'writeAtomic').mockRejectedValue(new Error('injected pre-commit failure'));
    execMock.mockRejectedValueOnce(new ProcessExecError({
      message: 'synthetic max buffer exceeded',
      output,
      exitCode: null,
      killed: true,
      maxBufferExceeded: true,
    }));

    const result = await createExecTool().execute({ command: 'unused' }, ctx);

    expect(result.success).toBe(false);
    expect(result.content.startsWith('Error: command output exceeded 1 MB limit.\n[output]: ')).toBe(true);
    expect(result.content).toMatch(/\n\[\.\.\.truncated \d+ bytes\.\.\.\]\n/);
    expect(result.content).toContain('[full output persistence failed; no artifact was saved.]');
    expect(result.metadata?.output).toEqual({ ownerBounded: true, artifact: { kind: 'failed' } });
    expect(Buffer.byteLength(result.content, 'utf8')).toBeLessThanOrEqual(EXEC_MAX_OUTPUT);
    expect(() => assertWellFormedUnicode(result.content)).not.toThrow();
    expect(result.content).not.toContain('Full output');
    expect(result.content).not.toContain('read:');
    expect(write).toHaveBeenCalledTimes(1);
    const files = await fs.promises.readdir(path.join(syncDir, 'exec')).catch(() => []);
    expect(files).toHaveLength(0);
  });

  it.each([
    {
      name: 'ordinary non-zero exit',
      output: '中'.repeat(1001),
      success: true,
      classification: '[exit 1]',
      error: { message: 'exit 1', exitCode: 1, killed: false },
    },
    {
      name: 'timeout',
      output: '😀'.repeat(501),
      success: false,
      classification: 'Error: Command timed out',
      error: { message: 'Command timed out after 1000ms', exitCode: null, killed: true },
    },
  ])('$name persists oversized error.output through the same async artifact path', async ({ output, success, classification, error }) => {
    const ctx = makeContext();
    const write = vi.spyOn(ctx.fs, 'writeAtomic');
    execMock.mockRejectedValueOnce(new ProcessExecError({ output, ...error }));

    const result = await createExecTool().execute({ command: 'unused' }, ctx);

    expect(result.success).toBe(success);
    expect(result.content).toContain(classification);
    expect(result.content).toContain('Full output');
    expect(Buffer.byteLength(result.content, 'utf8')).toBeLessThanOrEqual(EXEC_MAX_OUTPUT);
    expect(() => assertWellFormedUnicode(result.content)).not.toThrow();
    expect(write).toHaveBeenCalledTimes(1);
    const artifact = result.metadata?.output?.artifact;
    expect(artifact?.kind).toBe('durable');
    if (artifact === undefined || artifact.kind === 'failed') throw new Error('expected durable artifact');
    const saved = await fs.promises.readFile(path.resolve(path.join(tempDir, 'clawspace'), artifact.path), 'utf8');
    expect(saved.endsWith(output)).toBe(true);
  });

  it('bounds a long non-ProcessExecError after persisting the complete diagnostic', async () => {
    const ctx = makeContext();
    const write = vi.spyOn(ctx.fs, 'writeAtomic');
    execMock.mockRejectedValueOnce(new Error(`spawn failed: ${'中'.repeat(EXEC_MAX_OUTPUT)}`));

    const result = await createExecTool().execute({ command: 'unused' }, ctx);

    expect(result.success).toBe(false);
    expect(result.content.startsWith('Error: spawn failed: 中')).toBe(true);
    expect(Buffer.byteLength(result.content, 'utf8')).toBeLessThanOrEqual(EXEC_MAX_OUTPUT);
    expect(() => assertWellFormedUnicode(result.content)).not.toThrow();
    expect(result.metadata?.output).toMatchObject({
      ownerBounded: true,
      artifact: { kind: 'durable', path: expect.stringContaining('tasks/sync/exec/') },
    });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('exactly 2000B output persists when the fixed prefix pushes the final response over budget', async () => {
    const output = `${'中'.repeat(666)}ab`;
    execMock.mockRejectedValueOnce(new ProcessExecError({
      message: 'synthetic max buffer exceeded',
      output,
      exitCode: null,
      killed: true,
      maxBufferExceeded: true,
    }));

    const result = await createExecTool().execute({ command: 'unused' }, makeContext());

    expect(Buffer.byteLength(output, 'utf8')).toBe(2000);
    expect(result.success).toBe(false);
    expect(result.content).toContain('Error: command output exceeded 1 MB limit.');
    expect(result.content).toContain('Full output (2111 bytes) saved.');
    expect(Buffer.byteLength(result.content, 'utf8')).toBeLessThanOrEqual(EXEC_MAX_OUTPUT);
    expect(result.metadata?.output).toMatchObject({
      ownerBounded: true,
      artifact: { kind: 'durable', path: expect.stringContaining('tasks/sync/exec/') },
    });
    expect(() => assertWellFormedUnicode(result.content)).not.toThrow();
    const files = await fs.promises.readdir(path.join(syncDir, 'exec')).catch(() => []);
    expect(files).toHaveLength(1);
  });
});
