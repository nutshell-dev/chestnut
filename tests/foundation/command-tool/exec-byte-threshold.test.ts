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

    const prefix = 'Error: command output exceeded 1 MB limit.\n[output]: ';
    const previewBudget = EXEC_MAX_OUTPUT
      - Buffer.byteLength(prefix, 'utf8')
      - Buffer.byteLength('\n[truncated]', 'utf8');
    const preview = truncateUtf8Prefix(output, previewBudget);
    expect(result.success).toBe(false);
    expect(result.content).toBe(`${prefix}${preview}\n[truncated]`);
    expect(Buffer.byteLength(result.content, 'utf8')).toBeLessThanOrEqual(EXEC_MAX_OUTPUT);
    expect(() => assertWellFormedUnicode(result.content)).not.toThrow();
    expect(result.content).not.toContain('Full output');
    expect(result.content).not.toContain('read:');
    expect(write).toHaveBeenCalledTimes(1);
    const files = await fs.promises.readdir(path.join(syncDir, 'exec')).catch(() => []);
    expect(files).toHaveLength(0);
  });

  it('exactly 2000B budgets the partial-output fallback without persistence', async () => {
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
    const prefix = 'Error: command output exceeded 1 MB limit. Use head/tail to truncate, or redirect to a file.\n[partial output]: ';
    const previewBudget = EXEC_MAX_OUTPUT
      - Buffer.byteLength(prefix, 'utf8')
      - Buffer.byteLength('\n[truncated]', 'utf8');
    const preview = truncateUtf8Prefix(output, previewBudget);
    expect(result.success).toBe(false);
    expect(result.content).toBe(`${prefix}${preview}\n[truncated]`);
    expect(Buffer.byteLength(result.content, 'utf8')).toBeLessThanOrEqual(EXEC_MAX_OUTPUT);
    expect(() => assertWellFormedUnicode(result.content)).not.toThrow();
    expect(result.content).not.toContain('Full output');
    const files = await fs.promises.readdir(path.join(syncDir, 'exec')).catch(() => []);
    expect(files).toHaveLength(0);
  });
});
