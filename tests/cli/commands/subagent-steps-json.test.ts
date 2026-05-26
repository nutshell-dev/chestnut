/**
 * subagent steps + step --json output tests (phase 891 Step B)
 *
 * Coverage: --json shape + fallback text path + empty turns.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import { subagentStepsCommand, subagentStepCommand } from '../../../src/cli/commands/subagent-steps.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
    readFileSync: vi.fn(),
    statSync: vi.fn(() => ({ mtime: new Date(), size: 0 })),
    realpathSync: vi.fn((p: string) => p),
  };
});

vi.mock('../../../src/cli/commands/subagent-helpers.js', () => ({
  resolveClawDir: vi.fn().mockReturnValue('/tmp/claws/test-claw'),
}));

vi.mock('../../../src/cli/commands/_message-renderer.js', () => ({
  loadSessionFromFile: vi.fn().mockReturnValue({ messages: [] }),
  parseMessagesFromSession: vi.fn().mockReturnValue([
    {
      num: 1,
      texts: ['hello'],
      thinkings: [],
      toolUses: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/tmp/a' } }],
      toolResults: new Map([['tu1', { type: 'tool_result', tool_use_id: 'tu1', content: 'ok', is_error: false }]]),
    },
  ]),
  renderSteps: vi.fn().mockReturnValue('TURN  CALL  RESULT\n1  (text) "hello"'),
  renderStepFull: vi.fn().mockReturnValue('turn 1\n\ncall: Read\n\nfile_path: "/tmp/a"\n\nresult\n\nok\n'),
}));

describe('subagent steps --json', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { resolveClawDir } = await import('../../../src/cli/commands/subagent-helpers.js');
    vi.mocked(resolveClawDir).mockReturnValue('/tmp/claws/test-claw');

    const { loadSessionFromFile, parseMessagesFromSession, renderSteps, renderStepFull } = await import('../../../src/cli/commands/_message-renderer.js');
    vi.mocked(loadSessionFromFile).mockReturnValue({ messages: [] });
    vi.mocked(parseMessagesFromSession).mockReturnValue([
      {
        num: 1,
        texts: ['hello'],
        thinkings: [],
        toolUses: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/tmp/a' } }],
        toolResults: new Map([['tu1', { type: 'tool_result', tool_use_id: 'tu1', content: 'ok', is_error: false }]]),
      },
    ]);
    vi.mocked(renderSteps).mockReturnValue('TURN  CALL  RESULT\n1  (text) "hello"');
    vi.mocked(renderStepFull).mockReturnValue('turn 1\n\ncall: Read\n\nfile_path: "/tmp/a"\n\nresult\n\nok\n');

    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('outputs JSON for steps command', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    await subagentStepsCommand({ fsFactory }, 'task-1', 'test-claw', { json: true });

    const output = consoleLogSpy.mock.calls.flat().join('\n');
    const parsed = JSON.parse(output);
    expect(Array.isArray(parsed.turns)).toBe(true);
    expect(parsed.turns).toHaveLength(1);
    expect(parsed.turns[0].num).toBe(1);
    expect(parsed.turns[0].texts).toEqual(['hello']);
    expect(parsed.total).toBe(1);
    expect(parsed.as_of).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('outputs JSON for step command', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    await subagentStepCommand({ fsFactory }, '1', 'task-1', 'test-claw', { json: true });

    const output = consoleLogSpy.mock.calls.flat().join('\n');
    const parsed = JSON.parse(output);
    expect(parsed.turn_index).toBe(1);
    expect(parsed.slot).toBeNull();
    expect(parsed.turn.num).toBe(1);
    expect(parsed.as_of).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('falls back to text render without --json (steps)', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    await subagentStepsCommand({ fsFactory }, 'task-1', 'test-claw');

    const output = consoleLogSpy.mock.calls.flat().join('\n');
    expect(output).toContain('TURN');
  });

  it('falls back to text render without --json (step)', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    await subagentStepCommand({ fsFactory }, '1', 'task-1', 'test-claw');

    const output = consoleLogSpy.mock.calls.flat().join('\n');
    expect(output).toContain('turn 1');
  });

  it('outputs empty JSON when no turns (steps)', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const { parseMessagesFromSession } = await import('../../../src/cli/commands/_message-renderer.js');
    vi.mocked(parseMessagesFromSession).mockReturnValue([]);

    await subagentStepsCommand({ fsFactory }, 'task-1', 'test-claw', { json: true });

    const output = consoleLogSpy.mock.calls.flat().join('\n');
    const parsed = JSON.parse(output);
    expect(parsed.turns).toEqual([]);
    expect(parsed.total).toBe(0);
    expect(parsed.as_of).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});
