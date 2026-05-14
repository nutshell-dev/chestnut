import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { clawStepsCommand, clawStepCommand } from '../../src/cli/commands/claw-steps.js';
import { CliError } from '../../src/cli/errors.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('claw-steps', () => {
  let tmpDir: string;
  let originalRoot: string | undefined;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawforum-test-'));
    originalRoot = process.env.CLAWFORUM_ROOT;
    process.env.CLAWFORUM_ROOT = tmpDir;
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    if (originalRoot === undefined) {
      delete process.env.CLAWFORUM_ROOT;
    } else {
      process.env.CLAWFORUM_ROOT = originalRoot;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeCurrentJson(subPath: string, session: unknown) {
    const dir = path.join(tmpDir, '.clawforum', subPath, 'dialog');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify(session));
  }

  describe('clawStepsCommand', () => {
    it('motion 路由 → 输出 motion turn 结构', async () => {
      writeCurrentJson('motion', {
        messages: [
          { role: 'assistant', content: [{ type: 'text', text: 'motion hello' }] },
        ],
      });
      await clawStepsCommand('motion');
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('motion hello'));
    });

    it('claw 路由 → 输出 claw turn 结构', async () => {
      writeCurrentJson('claws/test-claw', {
        messages: [
          { role: 'assistant', content: [{ type: 'text', text: 'claw hello' }] },
        ],
      });
      await clawStepsCommand('test-claw');
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('claw hello'));
    });

    it('不存在 claw → CliError「Claw ... does not exist」', async () => {
      await clawStepsCommand('no-such');
      expect(process.exitCode).toBe(1);
      process.exitCode = undefined;
    });

    it('motion dir 缺失 → CliError「Motion directory not found」', async () => {
      await clawStepsCommand('motion');
      expect(process.exitCode).toBe(1);
      process.exitCode = undefined;
    });

    it('dialog/current.json 缺失 → CliError「dialog session not found」', async () => {
      const dir = path.join(tmpDir, '.clawforum', 'claws', 'empty-claw', 'dialog');
      fs.mkdirSync(dir, { recursive: true });
      await clawStepsCommand('empty-claw');
      expect(process.exitCode).toBe(1);
      process.exitCode = undefined;
    });

    it('空 turns → No turns found.', async () => {
      writeCurrentJson('motion', { messages: [] });
      await clawStepsCommand('motion');
      expect(consoleLogSpy).toHaveBeenCalledWith('No turns found.');
    });
  });

  describe('clawStepCommand', () => {
    it('step <n> 整 turn → 输出 turn full detail', async () => {
      writeCurrentJson('motion', {
        messages: [
          { role: 'assistant', content: [{ type: 'text', text: 'detail text' }] },
        ],
      });
      await clawStepCommand('1', 'motion');
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('detail text'));
    });

    it('step <n.x> slot → 输出 turn slot', async () => {
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
      await clawStepCommand('1.a', 'motion');
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('=== call: Read ==='));
    });

    it('step 不存在 → CliError「Turn N not found」', async () => {
      writeCurrentJson('motion', {
        messages: [
          { role: 'assistant', content: [{ type: 'text', text: 'only' }] },
        ],
      });
      await clawStepCommand('99', 'motion');
      expect(process.exitCode).toBe(1);
      process.exitCode = undefined;
    });

    it('step 格式非法 → CliError「Invalid step number」', async () => {
      writeCurrentJson('motion', { messages: [] });
      await clawStepCommand('abc', 'motion');
      expect(process.exitCode).toBe(1);
      process.exitCode = undefined;
    });
  });
});
