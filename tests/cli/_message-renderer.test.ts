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
import * as os from 'os';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

describe('_message-renderer', () => {
  describe('parseMessagesFromSession', () => {
    it('空 messages → 0 turn', () => {
      const session: SessionLike = { messages: [] };
      expect(parseMessagesFromSession(session)).toEqual([]);
    });

    it('单 assistant message text-only → 1 turn / 0 toolUse', () => {
      const session: SessionLike = {
        messages: [
          { role: 'assistant', content: [{ type: 'text', text: 'hello world' }] },
        ],
      };
      const turns = parseMessagesFromSession(session);
      expect(turns).toHaveLength(1);
      expect(turns[0].num).toBe(1);
      expect(turns[0].texts).toEqual(['hello world']);
      expect(turns[0].toolUses).toEqual([]);
    });

    it('assistant tool_use + 下条 user tool_result → 1 turn 含 toolUse + 配对 result', () => {
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
      const turns = parseMessagesFromSession(session);
      expect(turns).toHaveLength(1);
      expect(turns[0].toolUses).toHaveLength(1);
      expect(turns[0].toolResults.get('tu1')?.content).toBe('file content');
    });

    it('assistant thinking + text + tool_use 混合 → 1 turn 三 block 类全', () => {
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
      const turns = parseMessagesFromSession(session);
      expect(turns).toHaveLength(1);
      expect(turns[0].thinkings).toEqual(['ponder']);
      expect(turns[0].texts).toEqual(['ok']);
      expect(turns[0].toolUses).toHaveLength(1);
    });

    it('2 assistant message 连续 → 2 turn / 重号 1+2', () => {
      const session: SessionLike = {
        messages: [
          { role: 'assistant', content: [{ type: 'text', text: 'first' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'second' }] },
        ],
      };
      const turns = parseMessagesFromSession(session);
      expect(turns).toHaveLength(2);
      expect(turns[0].num).toBe(1);
      expect(turns[1].num).toBe(2);
    });
  });

  describe('renderSteps', () => {
    it('text-only turn → 1  (text) "..." 格式', () => {
      const session: SessionLike = {
        messages: [
          { role: 'assistant', content: [{ type: 'text', text: 'hello world' }] },
        ],
      };
      const turns = parseMessagesFromSession(session);
      const out = renderSteps(turns);
      expect(out).toContain('1  (text) "hello world"');
    });

    it('单 tool_use turn → 1  Read(...)  → result', () => {
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
      const turns = parseMessagesFromSession(session);
      const out = renderSteps(turns);
      expect(out).toContain('1  Read("/tmp/a")  → ok');
    });

    it('多 tool_use turn → 1.a + 1.b slot label', () => {
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
      const turns = parseMessagesFromSession(session);
      const out = renderSteps(turns);
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
      const turns = parseMessagesFromSession(session);
      const out = renderSteps(turns);
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
      const turns = parseMessagesFromSession(session);
      const out = renderSteps(turns);
      expect(out).toContain('→ ERR fail');
    });
  });

  describe('renderStepFull', () => {
    it('含 thinking + text + tool_use 完整 turn 输出 markers', () => {
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
      const turns = parseMessagesFromSession(session);
      const out = renderStepFull(turns[0]);
      expect(out).toContain('=== thinking ===');
      expect(out).toContain('think deep');
      expect(out).toContain('=== text ===');
      expect(out).toContain('here');
      expect(out).toContain('=== call: Read ===');
      expect(out).toContain('=== result ===');
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
      const turns = parseMessagesFromSession(session);
      const out = renderStepFull(turns[0], 0);
      expect(out).toContain('turn 1');
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
      const turns = parseMessagesFromSession(session);
      expect(() => renderStepFull(turns[0], 5)).toThrow(CliError);
    });
  });

  describe('loadSessionFromFile', () => {
    let tmpDir: string;
    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawforum-test-'));
    });
    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
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
      expect(loaded.messages).toHaveLength(1);
      expect(loaded.messages[0].role).toBe('assistant');
    });

    it('文件不存在 → 抛 CliError「dialog session not found」', () => {
      const filePath = path.join(tmpDir, 'no-such.json');
      expect(() => loadSessionFromFile({ fsFactory }, filePath)).toThrow(CliError);
      expect(() => loadSessionFromFile({ fsFactory }, filePath)).toThrow('dialog session not found');
    });
  });
});
