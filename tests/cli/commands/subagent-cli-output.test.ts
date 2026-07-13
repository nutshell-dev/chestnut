/**
 * subagent CLI command output tests
 *
 * phase 1395: merged from
 *   - subagent-list.test.ts (phase 954 Step B — --from/--to NaN guard)
 *   - subagent-steps-json.test.ts (phase 891 Step B — --json shape + fallback)
 *
 * Both test sibling CLI commands under src/cli/commands/subagent-*, share
 * identical vi.mock('fs', ...) + NodeFileSystem fsFactory pattern,
 * collect-dominated (4.47s collect / 45ms tests, ratio 99×).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import { subagentListCommand } from '../../../src/cli/commands/subagent-list.js';
import { subagentStepsCommand, subagentStepCommand } from '../../../src/cli/commands/subagent-steps.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
// phase 277: hoist 4 dyn imports of 2 unique modules
import { resolveClawDir } from '../../../src/cli/commands/subagent-helpers.js';
import { loadSessionFromFile, parseMessagesFromSession, renderSteps, renderStepFull } from '../../../src/cli/commands/_message-renderer.js';

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
  // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
  resolveClawDir: vi.fn().mockReturnValue('/tmp/claws/test-claw'),
  scanSubagentResults: vi.fn().mockReturnValue([
    {
      id: 'task-1',
      kind: 'spawn',
      status: 'completed',
      startedAt: new Date('2026-05-15T10:00:00Z'),
      durationMs: 120_000,
    },
  ]),
  formatDate: vi.fn(() => '2026-05-15 10:00'),
  formatDuration: vi.fn(() => '2m'),
  truncateId: vi.fn((id: string) => id),
}));

vi.mock('../../../src/cli/commands/_message-renderer.js', () => ({
  loadSessionFromFile: vi.fn().mockReturnValue({ session: { messages: [] }, source: 'current' }),
  parseMessagesFromSession: vi.fn().mockReturnValue([
    {
      num: 1,
      texts: ['hello'],
      thinkings: [],
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      toolUses: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/tmp/a' } }],
      toolResults: new Map([['tu1', { type: 'tool_result', tool_use_id: 'tu1', content: 'ok', is_error: false }]]),
    },
  ]),
  renderSteps: vi.fn().mockReturnValue('STEP  CALL  RESULT\n1  (text) "hello"'),
  renderStepFull: vi.fn().mockReturnValue('step 1\n\ncall: Read\n\nfile_path: "/tmp/a"\n\nresult\n\nok\n'),
}));

describe('subagent-list', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockReturnValue(true);
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    vi.mocked(resolveClawDir).mockReturnValue('/tmp/claws/test-claw');
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrSpy.mockRestore();
  });

  // phase 687 Step B (audit T2.11): subagentListCommand 删 outer try/catch、CliError 让外层 withCliErrorHandling 接
  // 测试名「throws CliError」原与 body 不符（旧行为内部 catch 转 console.error 输出）；新行为真 throw、断言改 rejects.toThrow 对齐名字
  it('--from garbage throws CliError (反向: NaN guard mirror --limit, phase 954)', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    await expect(
      subagentListCommand({ fsFactory }, { claw: 'test-claw', from: 'garbage' })
    ).rejects.toThrow('--from must be a valid date');
  });

  it('--to garbage throws CliError (反向: NaN guard mirror --limit, phase 954)', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    await expect(
      subagentListCommand({ fsFactory }, { claw: 'test-claw', to: 'not-a-date' })
    ).rejects.toThrow('--to must be a valid date');
  });
});

describe('subagent steps --json', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    vi.mocked(resolveClawDir).mockReturnValue('/tmp/claws/test-claw');

    vi.mocked(loadSessionFromFile).mockReturnValue({ session: { messages: [] }, source: 'current' });
    vi.mocked(parseMessagesFromSession).mockReturnValue([
      {
        num: 1,
        texts: ['hello'],
        thinkings: [],
        // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
        toolUses: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/tmp/a' } }],
        toolResults: new Map([['tu1', { type: 'tool_result', tool_use_id: 'tu1', content: 'ok', is_error: false }]]),
      },
    ]);
    vi.mocked(renderSteps).mockReturnValue('STEP  CALL  RESULT\n1  (text) "hello"');
    vi.mocked(renderStepFull).mockReturnValue('step 1\n\ncall: Read\n\nfile_path: "/tmp/a"\n\nresult\n\nok\n');

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
    expect(output).toContain('STEP');
  });

  it('falls back to text render without --json (step)', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    await subagentStepCommand({ fsFactory }, '1', 'task-1', 'test-claw');

    const output = consoleLogSpy.mock.calls.flat().join('\n');
    expect(output).toContain('step 1');
  });

  it('outputs empty JSON when no turns (steps)', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(parseMessagesFromSession).mockReturnValue([]);

    await subagentStepsCommand({ fsFactory }, 'task-1', 'test-claw', { json: true });

    const output = consoleLogSpy.mock.calls.flat().join('\n');
    const parsed = JSON.parse(output);
    expect(parsed.turns).toEqual([]);
    expect(parsed.total).toBe(0);
    expect(parsed.as_of).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});
