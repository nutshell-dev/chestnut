import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderSteps, type RenderStepsOpts } from '../../src/cli/commands/result-renderer.js';
import { clawStepsCommand } from '../../src/cli/commands/claw-steps.js';
import { motionStepsCommand } from '../../src/cli/commands/motion-steps.js';
import { subagentStepsCommand } from '../../src/cli/commands/subagent-steps.js';
import { clawTraceCommand } from '../../src/cli/commands/claw-trace.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import * as fs from 'fs';
import * as path from 'path';
import { createTrackedTempDir, cleanupTempDir } from '../utils/temp.js';

vi.mock('../../src/assembly/config/config-loader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/assembly/config/config-loader.js')>();
  return {
    ...actual,
  };
});
vi.mock('../../src/assembly/config/config-load.js', async () => ({
  loadGlobalConfig: vi.fn(),
  isInitialized: vi.fn(),
  saveGlobalConfig: vi.fn(),
  loadClawConfig: vi.fn(),
  patchGlobalConfigPrimary: vi.fn(),
  saveClawConfig: vi.fn(),
  clawExists: vi.fn(() => true),
  buildLLMConfig: vi.fn(),
}));

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

function makeSteps(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    num: i + 1,
    texts: [`text ${i + 1}`],
    thinkings: [] as string[],
    toolUses: [] as { type: 'tool_use'; id: string; name: string; input: unknown }[],
    toolResults: new Map<string, { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }>(),
    userInput: undefined as { content: string; chars: number } | undefined,
  }));
}

// ─── renderSteps hint core ──────────────────────────────────────────────────

describe('renderSteps hint invariant (phase 225)', () => {
  it('末尾含 hint (unless noHint or empty)', () => {
    const steps = makeSteps(3);
    const out = renderSteps(steps, { cliPrefix: 'motion' });
    expect(out).toContain('→ chestnut motion step <n> for full detail');
    expect(out).toContain('n=1..3');
    expect(out).toContain('N.<a-z> for tool slot');
  });

  it('noHint=true 抑制 hint', () => {
    const steps = makeSteps(2);
    const out = renderSteps(steps, { cliPrefix: 'motion', noHint: true });
    expect(out).not.toContain('→ chestnut');
  });

  it('empty steps 不加 hint', () => {
    const out = renderSteps([], { cliPrefix: 'motion' });
    expect(out).not.toContain('→ chestnut');
  });

  it('no cliPrefix 不加 hint (safety: 防漏传)', () => {
    const steps = makeSteps(2);
    const out = renderSteps(steps, {});
    expect(out).not.toContain('→ chestnut');
  });

  it('backward compatible: 无 opts 调用不加 hint', () => {
    const steps = makeSteps(2);
    const out = renderSteps(steps);
    expect(out).not.toContain('→ chestnut');
  });
});

// ─── claw-steps prefix wire ─────────────────────────────────────────────────

describe('clawStepsCommand hint wire', () => {
  let tmpDir: string;
  let originalRoot: string | undefined;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    tmpDir = await createTrackedTempDir('chestnut-test-');
    originalRoot = process.env.CHESTNUT_ROOT;
    process.env.CHESTNUT_ROOT = tmpDir;
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    consoleLogSpy.mockRestore();
    if (originalRoot === undefined) {
      delete process.env.CHESTNUT_ROOT;
    } else {
      process.env.CHESTNUT_ROOT = originalRoot;
    }
    await cleanupTempDir(tmpDir);
  });

  function writeCurrentJson(subPath: string, session: unknown) {
    const dir = path.join(tmpDir, '.chestnut', subPath, 'dialog');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify(session));
  }

  it('motion 路由 prefix 走 "motion"', async () => {
    writeCurrentJson('motion', {
      messages: [
        { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      ],
    });
    await clawStepsCommand({ fsFactory }, 'motion');
    const output = consoleLogSpy.mock.calls.flat().join('\n');
    expect(output).toContain('→ chestnut motion step <n> for full detail');
  });

  it('regular claw prefix 走 "claw <name>"', async () => {
    writeCurrentJson('claws/test-claw', {
      messages: [
        { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      ],
    });
    await clawStepsCommand({ fsFactory }, 'test-claw');
    const output = consoleLogSpy.mock.calls.flat().join('\n');
    expect(output).toContain('→ chestnut claw test-claw step <n> for full detail');
  });

  it('noHint 抑制 hint', async () => {
    writeCurrentJson('motion', {
      messages: [
        { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      ],
    });
    await clawStepsCommand({ fsFactory }, 'motion', { noHint: true });
    const output = consoleLogSpy.mock.calls.flat().join('\n');
    expect(output).not.toContain('→ chestnut');
  });

  it('0 step 不加 hint', async () => {
    writeCurrentJson('motion', { messages: [] });
    await clawStepsCommand({ fsFactory }, 'motion');
    expect(consoleLogSpy).toHaveBeenCalledWith('No steps found.');
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
  });
});

// ─── motion-steps hint wire ─────────────────────────────────────────────────

describe('motionStepsCommand hint wire', () => {
  let tmpDir: string;
  let originalRoot: string | undefined;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    tmpDir = await createTrackedTempDir('chestnut-test-');
    originalRoot = process.env.CHESTNUT_ROOT;
    process.env.CHESTNUT_ROOT = tmpDir;
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    consoleLogSpy.mockRestore();
    if (originalRoot === undefined) {
      delete process.env.CHESTNUT_ROOT;
    } else {
      process.env.CHESTNUT_ROOT = originalRoot;
    }
    await cleanupTempDir(tmpDir);
  });

  function writeCurrentJson(subPath: string, session: unknown) {
    const dir = path.join(tmpDir, '.chestnut', subPath, 'dialog');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify(session));
  }

  it('motion steps 输出含 motion prefix hint', async () => {
    writeCurrentJson('motion', {
      messages: [
        { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      ],
    });
    await motionStepsCommand({ fsFactory });
    const output = consoleLogSpy.mock.calls.flat().join('\n');
    expect(output).toContain('→ chestnut motion step <n> for full detail');
  });

  it('motion steps noHint 抑制 hint', async () => {
    writeCurrentJson('motion', {
      messages: [
        { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      ],
    });
    await motionStepsCommand({ fsFactory }, { noHint: true });
    const output = consoleLogSpy.mock.calls.flat().join('\n');
    expect(output).not.toContain('→ chestnut');
  });
});

// ─── subagent-steps prefix wire ─────────────────────────────────────────────

describe('subagentStepsCommand hint wire', () => {
  let tmpDir: string;
  let originalRoot: string | undefined;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    tmpDir = await createTrackedTempDir('chestnut-test-');
    originalRoot = process.env.CHESTNUT_ROOT;
    process.env.CHESTNUT_ROOT = tmpDir;
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    consoleLogSpy.mockRestore();
    if (originalRoot === undefined) {
      delete process.env.CHESTNUT_ROOT;
    } else {
      process.env.CHESTNUT_ROOT = originalRoot;
    }
    await cleanupTempDir(tmpDir);
  });

  function setupClaw(name: string) {
    const clawDir = path.join(tmpDir, '.chestnut', 'claws', name);
    fs.mkdirSync(clawDir, { recursive: true });
    return clawDir;
  }

  function writeMessages(clawDir: string, id: string, messages: unknown[]) {
    const dir = path.join(clawDir, 'tasks', 'queues', 'results', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'messages.json'), JSON.stringify({ messages }));
  }

  it('subagent steps 输出含 subagent <id> prefix hint', async () => {
    const clawDir = setupClaw('test-claw');
    writeMessages(clawDir, 'sub-1', [
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    ]);
    await subagentStepsCommand({ fsFactory }, 'sub-1', 'test-claw');
    const output = consoleLogSpy.mock.calls.flat().join('\n');
    expect(output).toContain('→ chestnut subagent sub-1 step <n> for full detail');
  });

  it('subagent steps noHint 抑制 hint', async () => {
    const clawDir = setupClaw('test-claw');
    writeMessages(clawDir, 'sub-1', [
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    ]);
    await subagentStepsCommand({ fsFactory }, 'sub-1', 'test-claw', { noHint: true });
    const output = consoleLogSpy.mock.calls.flat().join('\n');
    expect(output).not.toContain('→ chestnut');
  });

  it('subagent steps json 模式不加 hint', async () => {
    const clawDir = setupClaw('test-claw');
    writeMessages(clawDir, 'sub-1', [
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    ]);
    await subagentStepsCommand({ fsFactory }, 'sub-1', 'test-claw', { json: true });
    const output = consoleLogSpy.mock.calls.flat().join('\n');
    expect(output).not.toContain('→ chestnut');
    const parsed = JSON.parse(output);
    expect(parsed.total).toBe(1);
  });
});

// ─── trace hint wire ────────────────────────────────────────────────────────

describe('clawTraceCommand hint wire', () => {
  let tmpDir: string;
  let originalRoot: string | undefined;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    tmpDir = await createTrackedTempDir('chestnut-test-');
    originalRoot = process.env.CHESTNUT_ROOT;
    process.env.CHESTNUT_ROOT = tmpDir;
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    consoleLogSpy.mockRestore();
    if (originalRoot === undefined) {
      delete process.env.CHESTNUT_ROOT;
    } else {
      process.env.CHESTNUT_ROOT = originalRoot;
    }
    await cleanupTempDir(tmpDir);
  });

  function setupClawTrace(clawId: string, contractId: string) {
    const clawDir = path.join(tmpDir, '.chestnut', 'claws', clawId);
    fs.mkdirSync(clawDir, { recursive: true });

    // progress.json with started_at
    const activeDir = path.join(clawDir, 'contract', 'active', contractId);
    fs.mkdirSync(activeDir, { recursive: true });
    fs.writeFileSync(
      path.join(activeDir, 'progress.json'),
      JSON.stringify({ started_at: new Date().toISOString() }),
    );

    // stream.jsonl with llm_start + tool_result events
    fs.writeFileSync(
      path.join(clawDir, 'stream.jsonl'),
      JSON.stringify({ ts: Date.now(), type: 'llm_start' }) + '\n' +
      JSON.stringify({ ts: Date.now() + 1, type: 'tool_result', name: 'Read', tool_use_id: 'tu1' }) + '\n',
    );

    // claw config.yaml (required by clawExists)
    fs.writeFileSync(
      path.join(clawDir, 'config.yaml'),
      'default_llm:\n  provider: test\n',
    );
  }

  it('trace overview 含 --step hint', async () => {
    setupClawTrace('test-claw', 'contract-1');
    await clawTraceCommand({ fsFactory }, 'test-claw', 'contract-1');
    const output = consoleLogSpy.mock.calls.flat().join('\n');
    expect(output).toContain('→ chestnut claw test-claw trace --contract contract-1 --step <n> for full detail');
    expect(output).toContain('n=1..1');
  });

  it('trace overview noHint 抑制 hint', async () => {
    setupClawTrace('test-claw', 'contract-1');
    await clawTraceCommand({ fsFactory }, 'test-claw', 'contract-1', undefined, { noHint: true });
    const output = consoleLogSpy.mock.calls.flat().join('\n');
    expect(output).not.toContain('→ chestnut');
  });

  it('trace step detail 不加 hint (leaf node)', async () => {
    setupClawTrace('test-claw', 'contract-1');
    await clawTraceCommand({ fsFactory }, 'test-claw', 'contract-1', '1');
    const output = consoleLogSpy.mock.calls.flat().join('\n');
    expect(output).not.toContain('→ chestnut');
  });
});

// ─── commander --no-hint source structure ───────────────────────────────────

describe('commander --no-hint flag wire structure', () => {
  const indexSource = fs.readFileSync(
    path.join(__dirname, '../../src/cli/index.ts'),
    'utf-8',
  );
  const subagentSource = fs.readFileSync(
    path.join(__dirname, '../../src/cli/commands/subagent.ts'),
    'utf-8',
  );
  const routerSource = fs.readFileSync(
    path.join(__dirname, '../../src/cli/commands/claw-router.ts'),
    'utf-8',
  );

  it('motion steps registers --no-hint and translates opts.hint === false', () => {
    const idx = indexSource.indexOf("motionCmd\n  .command('steps')");
    expect(idx).toBeGreaterThan(-1);
    const block = indexSource.slice(idx, idx + 400);
    expect(block).toContain(".option('--no-hint',");
    expect(block).toContain('opts.hint === false');
  });

  it('subagent steps registers --no-hint and translates opts.hint === false', () => {
    expect(subagentSource).toContain(".option('--no-hint',");
    expect(subagentSource).toContain('opts.hint === false');
  });

  it('claw router runSteps registers --no-hint and translates opts.hint === false', () => {
    expect(routerSource).toContain("parser.option('--no-hint',");
    const stepsIdx = routerSource.indexOf("function runSteps(");
    expect(stepsIdx).toBeGreaterThan(-1);
    // phase 687 Step D: window 600 → 800、容纳 catch 块加 { cause: err } 后的字符增长（audit T3.11）
    const block = routerSource.slice(stepsIdx, stepsIdx + 800);
    expect(block).toContain('opts.hint === false');
  });

  it('claw router runTrace registers --no-hint and translates opts.hint === false', () => {
    const traceIdx = routerSource.indexOf("function runTrace(");
    expect(traceIdx).toBeGreaterThan(-1);
    // phase 687 Step D: window 900 → 1100、容纳 catch 块加 { cause: err } 后的字符增长（audit T3.11）
    const block = routerSource.slice(traceIdx, traceIdx + 1100);
    expect(block).toContain("parser.option('--no-hint',");
    expect(block).toContain('opts.hint === false');
  });
});
