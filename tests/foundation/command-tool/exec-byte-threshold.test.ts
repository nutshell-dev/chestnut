import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { createExecTool } from '../../../src/foundation/command-tool/exec.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
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

  it('exactly 2000B keeps the partial-output fallback without persistence', async () => {
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
    expect(result.content).toContain(`[partial output]: ${output}`);
    expect(result.content).not.toContain('Full output');
    const files = await fs.promises.readdir(path.join(syncDir, 'exec')).catch(() => []);
    expect(files).toHaveLength(0);
  });
});
