import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseMessagesFromSession,
  renderSteps,
  renderStepFull,
  loadSessionFromFile,
  type SessionLike,
} from '../../src/cli/commands/_message-renderer.js';
import { CliError } from '../../src/cli/errors.js';
import type { Message, ToolUseBlock, ToolResultBlock } from '../../src/foundation/llm-provider/types.js';
import * as fs from 'fs';
import * as path from 'path';
import { createTrackedTempDir, cleanupTempDir } from '../utils/temp.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

describe('_message-renderer', () => {
  describe('parseMessagesFromSession', () => {
    it('空 messages → 0 step', () => {
      const session: SessionLike = { messages: [] };
      expect(parseMessagesFromSession(session)).toEqual([]);
    });

    it('单 assistant message text-only → 1 step / 0 toolUse', () => {
      const session: SessionLike = {
        messages: [
          { role: 'assistant', content: [{ type: 'text', text: 'hello world' }] },
        ],
      };
      const steps = parseMessagesFromSession(session);
      expect(steps).toHaveLength(1);
      expect(steps[0].num).toBe(1);
      expect(steps[0].texts).toEqual(['hello world']);
      expect(steps[0].toolUses).toEqual([]);
    });

    it('assistant tool_use + 下条 user tool_result → 1 step 含 toolUse + 配对 result', () => {
      const session: SessionLike = {
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/tmp/a' } },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'tu1', content: 'file content' },
            ],
          },
        ],
      };
      const steps = parseMessagesFromSession(session);
      expect(steps).toHaveLength(1);
      expect(steps[0].toolUses).toHaveLength(1);
      expect(steps[0].toolResults.get('tu1')?.content).toBe('file content');
    });

    it('assistant thinking + text + tool_use 混合 → 1 step 三 block 类全', () => {
      const session: SessionLike = {
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'ponder' },
              { type: 'text', text: 'ok' },
              { type: 'tool_use', id: 'tu2', name: 'Bash', input: { command: 'ls' } },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'tu2', content: 'a\nb' },
            ],
          },
        ],
      };
      const steps = parseMessagesFromSession(session);
      expect(steps).toHaveLength(1);
      expect(steps[0].thinkings).toEqual(['ponder']);
      expect(steps[0].texts).toEqual(['ok']);
      expect(steps[0].toolUses).toHaveLength(1);
    });

    it('2 assistant message 连续 → 2 step / 重号 1+2', () => {
      const session: SessionLike = {
        messages: [
          { role: 'assistant', content: [{ type: 'text', text: 'first' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'second' }] },
        ],
      };
      const steps = parseMessagesFromSession(session);
      expect(steps).toHaveLength(2);
      expect(steps[0].num).toBe(1);
      expect(steps[1].num).toBe(2);
    });

    it('user text message → attribute 到下一 assistant step 的 userInput', () => {
      const session: SessionLike = {
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hello there' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
        ],
      };
      const steps = parseMessagesFromSession(session);
      expect(steps).toHaveLength(1);
      expect(steps[0].userInput).toEqual({ content: 'hello there', chars: 11 });
    });

    it('user tool_result message → 不生成 userInput', () => {
      const session: SessionLike = {
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
              { type: 'tool_result', tool_use_id: 'tu1', content: 'ok' },
            ],
          },
        ],
      };
      const steps = parseMessagesFromSession(session);
      expect(steps).toHaveLength(1);
      expect(steps[0].userInput).toBeUndefined();
    });

    it('user text + assistant + user text + assistant → 2 step 各带 userInput', () => {
      const session: SessionLike = {
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'q1' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
          { role: 'user', content: [{ type: 'text', text: 'q2' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'a2' }] },
        ],
      };
      const steps = parseMessagesFromSession(session);
      expect(steps).toHaveLength(2);
      expect(steps[0].userInput).toEqual({ content: 'q1', chars: 2 });
      expect(steps[1].userInput).toEqual({ content: 'q2', chars: 2 });
    });
  });

  describe('renderSteps', () => {
    it('text-only step → 1  (text) "..." 格式', () => {
      const session: SessionLike = {
        messages: [
          { role: 'assistant', content: [{ type: 'text', text: 'hello world' }] },
        ],
      };
      const steps = parseMessagesFromSession(session);
      const out = renderSteps(steps);
      expect(out).toContain('1  (text) "hello world"');
    });

    it('单 tool_use step → 1  Read(...)  → result', () => {
      const session: SessionLike = {
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/tmp/a' } },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'tu1', content: 'ok' },
            ],
          },
        ],
      };
      const steps = parseMessagesFromSession(session);
      const out = renderSteps(steps);
      expect(out).toContain('1  Read("/tmp/a")  → ok');
    });

    it('多 tool_use step → 1.a + 1.b slot label', () => {
      const session: SessionLike = {
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/a' } },
              { type: 'tool_use', id: 'tu2', name: 'Read', input: { file_path: '/b' } },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'tu1', content: 'r1' },
              { type: 'tool_result', tool_use_id: 'tu2', content: 'r2' },
            ],
          },
        ],
      };
      const steps = parseMessagesFromSession(session);
      const out = renderSteps(steps);
      expect(out).toContain('1.a');
      expect(out).toContain('1.b');
    });

    it('pending result → → (pending)', () => {
      const session: SessionLike = {
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/a' } },
            ],
          },
        ],
      };
      const steps = parseMessagesFromSession(session);
      const out = renderSteps(steps);
      expect(out).toContain('→ (pending)');
    });

    it('error result → → ERR ...', () => {
      const session: SessionLike = {
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
              { type: 'tool_result', tool_use_id: 'tu1', content: 'fail', is_error: true },
            ],
          },
        ],
      };
      const steps = parseMessagesFromSession(session);
      const out = renderSteps(steps);
      expect(out).toContain('→ ERR fail');
    });

    it('user input row 在 steps list 中 surface', () => {
      const session: SessionLike = {
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'do something' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
        ],
      };
      const steps = parseMessagesFromSession(session);
      const out = renderSteps(steps);
      expect(out).toContain('STEP  CALL  RESULT');
      expect(out).toContain('1  (user) "do something"');
      expect(out).toContain('1  (text) "ok"');
    });
  });

  describe('renderStepFull', () => {
    it('含 thinking + text + tool_use 完整 step 输出 markers', () => {
      const session: SessionLike = {
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'think deep' },
              { type: 'text', text: 'here' },
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
      };
      const steps = parseMessagesFromSession(session);
      const out = renderStepFull(steps[0]);
      expect(out).toContain('=== thinking (10chars) ===');
      expect(out).toContain('think deep');
      expect(out).toContain('=== text (4chars) ===');
      expect(out).toContain('here');
      expect(out).toContain('=== call: Read ===');
      expect(out).toContain('=== result (2chars) ===');
      expect(out).toContain('r1');
    });

    it('slot 选择 slotIdx=0 输出单 slot', () => {
      const session: SessionLike = {
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
      };
      const steps = parseMessagesFromSession(session);
      const out = renderStepFull(steps[0], 0);
      expect(out).toContain('step 1');
      expect(out).toContain('=== call: Read ===');
    });

    it('slot 越界报 CliError', () => {
      const session: SessionLike = {
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/a' } },
            ],
          },
        ],
      };
      const steps = parseMessagesFromSession(session);
      expect(() => renderStepFull(steps[0], 5)).toThrow(CliError);
    });

    it('含 user input 的 step full 输出 user input section', () => {
      const session: SessionLike = {
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hello' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'world' }] },
        ],
      };
      const steps = parseMessagesFromSession(session);
      const out = renderStepFull(steps[0]);
      expect(out).toContain('step 1');
      expect(out).toContain('=== user input (5chars) ===');
      expect(out).toContain('hello');
      expect(out).toContain('=== text (5chars) ===');
      expect(out).toContain('world');
    });
  });

  describe('loadSessionFromFile', () => {
    let tmpDir: string;
    beforeEach(async () => {
      tmpDir = await createTrackedTempDir('chestnut-test-');
    });
    afterEach(async () => {
      await cleanupTempDir(tmpDir);
    });

    it('文件存在 + 合法 JSON → 返 SessionLike', () => {
      const filePath = path.join(tmpDir, 'session.json');
      const session: SessionLike = {
        messages: [
          { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
        ],
      };
      fs.writeFileSync(filePath, JSON.stringify(session));
      const loaded = loadSessionFromFile({ fsFactory }, filePath);
      expect(loaded.session.messages).toHaveLength(1);
      expect(loaded.session.messages[0].role).toBe('assistant');
    });

    it('文件不存在 → 抛 CliError「dialog session not found」', () => {
      const filePath = path.join(tmpDir, 'no-such.json');
      expect(() => loadSessionFromFile({ fsFactory }, filePath)).toThrow(CliError);
      expect(() => loadSessionFromFile({ fsFactory }, filePath)).toThrow('dialog session not found');
    });
  });
});
