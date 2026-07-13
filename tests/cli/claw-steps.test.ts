import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { clawStepsCommand, clawStepCommand } from '../../src/cli/commands/claw-steps.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });
import { CliError } from '../../src/cli/errors.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('claw-steps', () => {
  let tmpDir: string;
  let originalRoot: string | undefined;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chestnut-test-'));
    originalRoot = process.env.CHESTNUT_ROOT;
    process.env.CHESTNUT_ROOT = tmpDir;
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    if (originalRoot === undefined) {
      delete process.env.CHESTNUT_ROOT;
    } else {
      process.env.CHESTNUT_ROOT = originalRoot;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeCurrentJson(subPath: string, session: unknown) {
    const dir = path.join(tmpDir, '.chestnut', subPath, 'dialog');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify(session));
  }

  describe('clawStepsCommand', () => {
    it('motion 路由 → 输出 motion step 结构', async () => {
      writeCurrentJson('motion', {
        messages: [
          { role: 'assistant', content: [{ type: 'text', text: 'motion hello' }] },
        ],
      });
      await clawStepsCommand({ fsFactory }, 'motion');
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('motion hello'));
    });

    it('claw 路由 → 输出 claw step 结构', async () => {
      writeCurrentJson('claws/test-claw', {
        messages: [
          { role: 'assistant', content: [{ type: 'text', text: 'claw hello' }] },
        ],
      });
      await clawStepsCommand({ fsFactory }, 'test-claw');
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('claw hello'));
    });

    it('不存在 claw → CliError「Claw ... does not exist」', async () => {
      await expect(clawStepsCommand({ fsFactory }, 'no-such')).rejects.toThrow('Claw "no-such" does not exist');
    });

    it('motion dir 缺失 → CliError「Motion directory not found」', async () => {
      await expect(clawStepsCommand({ fsFactory }, 'motion')).rejects.toThrow('Motion directory not found');
    });

    it('dialog/current.json 缺失 → CliError「dialog session not found」', async () => {
      const dir = path.join(tmpDir, '.chestnut', 'claws', 'empty-claw', 'dialog');
      fs.mkdirSync(dir, { recursive: true });
      await expect(clawStepsCommand({ fsFactory }, 'empty-claw')).rejects.toThrow('dialog session not found');
    });

    it('空 steps → No steps found.', async () => {
      writeCurrentJson('motion', { messages: [] });
      await clawStepsCommand({ fsFactory }, 'motion');
      expect(consoleLogSpy).toHaveBeenCalledWith('No steps found.');
    });
  });

  describe('clawStepCommand', () => {
    it('step <n> 整 step → 输出 step full detail', async () => {
      writeCurrentJson('motion', {
        messages: [
          { role: 'assistant', content: [{ type: 'text', text: 'detail text' }] },
        ],
      });
      await clawStepCommand({ fsFactory }, '1', 'motion');
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('detail text'));
    });

    it('step <n.x> slot → 输出 step slot', async () => {
      writeCurrentJson('motion', {
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/a' } },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'tu1', content: 'r1' },
            ],
          },
        ],
      });
      await clawStepCommand({ fsFactory }, '1.a', 'motion');
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('=== call: Read ==='));
    });

    it('step 不存在 → CliError「Step N not found」', async () => {
      writeCurrentJson('motion', {
        messages: [
          { role: 'assistant', content: [{ type: 'text', text: 'only' }] },
        ],
      });
      await expect(clawStepCommand({ fsFactory }, '99', 'motion')).rejects.toThrow('Step 99 not found');
    });

    it('step 格式非法 → CliError「Invalid step number」', async () => {
      writeCurrentJson('motion', { messages: [] });
      await expect(clawStepCommand({ fsFactory }, 'abc', 'motion')).rejects.toThrow('Invalid step number: abc');
    });
  });
});
