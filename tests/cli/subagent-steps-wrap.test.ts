import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  subagentStepsCommand,
  subagentStepCommand,
} from '../../src/cli/commands/subagent-steps.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

describe('subagent-steps wrap', () => {
  let tmpDir: string;
  let originalRoot: string | undefined;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chestnut-test-'));
    originalRoot = process.env.CHESTNUT_ROOT;
    process.env.CHESTNUT_ROOT = tmpDir;
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrSpy.mockRestore();
    exitSpy.mockRestore();
    if (originalRoot === undefined) {
      delete process.env.CHESTNUT_ROOT;
    } else {
      process.env.CHESTNUT_ROOT = originalRoot;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function setupClaw(name: string) {
    const clawDir = path.join(tmpDir, '.chestnut', 'claws', name);
    fs.mkdirSync(clawDir, { recursive: true });
    return clawDir;
  }

  function writeMessages(clawDir: string, id: string, messages: unknown[]) {
    const dir = path.join(clawDir, 'tasks', 'queues', 'results', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'messages.json'),
      JSON.stringify({ messages }),
    );
  }

  it('step out-of-range non-JSON → throws CliError (outer wrapper handles single console.error)', async () => {
    const clawDir = setupClaw('test-claw');
    writeMessages(clawDir, 'sub-1', [
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    ]);

    // When called directly (simulating outer .action wrapper), the throw propagates
    // and wrapper calls handleCliError → console.error once.
    await expect(subagentStepCommand({ fsFactory }, '5', 'sub-1', 'test-claw')).rejects.toThrow(
      'step 5 out of range (total steps: 1)',
    );
    // No direct console.error in the function anymore (throw handles it)
    expect(consoleErrSpy).not.toHaveBeenCalled();
  });

  it('step out-of-range JSON → process.exit(1) directly, no double emit', async () => {
    const clawDir = setupClaw('test-claw');
    writeMessages(clawDir, 'sub-1', [
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    ]);

    await expect(
      subagentStepCommand({ fsFactory }, '5', 'sub-1', 'test-claw', { json: true }),
    ).rejects.toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(exitSpy).toHaveBeenCalledTimes(1);
    // console.log for JSON output, no console.error
    expect(consoleErrSpy).not.toHaveBeenCalled();
  });

  it('steps happy path non-JSON → console.log once, no exit', async () => {
    const clawDir = setupClaw('test-claw');
    writeMessages(clawDir, 'sub-1', [
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    ]);

    await subagentStepsCommand({ fsFactory }, 'sub-1', 'test-claw');
    expect(exitSpy).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
  });

  it('steps claw not exist → throws CliError (propagates to wrapper)', async () => {
    await expect(subagentStepsCommand({ fsFactory }, 'sub-1', 'no-such-claw')).rejects.toThrow(
      'Claw "no-such-claw" does not exist',
    );
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
