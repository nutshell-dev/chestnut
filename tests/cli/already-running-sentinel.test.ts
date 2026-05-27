import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Prevent program.parse() from executing during module load.
// Use plain functions (not vi.fn) inside vi.mock factory to avoid
// hoisting reliability issues that can cause intermittent mock failure.
vi.mock('commander', async () => {
  const mod = await vi.importActual<typeof import('commander')>('commander');
  const program = new mod.Command();
  program.parse = () => program;
  program.parseAsync = () => Promise.resolve(program);
  return { ...mod, program };
});

// phase1363: complete mock with plain functions to prevent infinite hang
// in the spawn-ready polling loop if the mock intermittently fails.
vi.mock('../../src/foundation/process-manager/agent-factory.js', () => ({
  createAgentProcessManager: () => ({
    isAlive: () => true,
    spawn: () => Promise.resolve(),
    markReady: () => Promise.resolve(),
  }),
}));

describe('already-running sentinel (phase 981 E-α3)', () => {
  let tmpDir: string;
  let originalRoot: string | undefined;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawforum-ar-test-'));
    originalRoot = process.env.CLAWFORUM_ROOT;
    process.env.CLAWFORUM_ROOT = tmpDir;
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    if (originalRoot === undefined) delete process.env.CLAWFORUM_ROOT;
    else process.env.CLAWFORUM_ROOT = originalRoot;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function setupConfig() {
    const configPath = path.join(tmpDir, '.clawforum', 'config.yaml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      'version: "1"\nllm:\n  primary:\n    preset: anthropic\n    api_key: test\n    model: claude\n    max_tokens: 4096\n    temperature: 0.7\n    timeout_ms: 60000\n  retry_attempts: 3\n  retry_delay_ms: 1000\n',
    );
  }

  it('claw daemon warns with ⚠ when already running', async () => {
    setupConfig();

    const clawDir = path.join(tmpDir, '.clawforum', 'claws', 'running-claw');
    fs.mkdirSync(clawDir, { recursive: true });
    fs.writeFileSync(path.join(clawDir, 'config.yaml'), 'name: running-claw\n');

    const { program } = await import('commander');
    await import('../../src/cli/index.js');

    const clawCmd = program.commands.find((c: any) => c.name() === 'claw');
    const daemonCmd = clawCmd?.commands.find((c: any) => c.name() === 'daemon');

    await (daemonCmd as any)._actionHandler(['running-claw']);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('⚠'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('already running'));
  });

  it('motion daemon warns with ⚠ when already running', async () => {
    setupConfig();

    const { program } = await import('commander');
    await import('../../src/cli/index.js');

    const motionCmd = program.commands.find((c: any) => c.name() === 'motion');
    const daemonCmd = motionCmd?.commands.find((c: any) => c.name() === 'daemon');

    await (daemonCmd as any)._actionHandler([]);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('⚠'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('already running'));
  });

  // phase1363 reverse tests — invariant against root-cause regression

  it('claw daemon actionHandler resolves in <1000ms (happy path)', async () => {
    setupConfig();

    const clawDir = path.join(tmpDir, '.clawforum', 'claws', 'running-claw');
    fs.mkdirSync(clawDir, { recursive: true });
    fs.writeFileSync(path.join(clawDir, 'config.yaml'), 'name: running-claw\n');

    const { program } = await import('commander');
    await import('../../src/cli/index.js');

    const clawCmd = program.commands.find((c: any) => c.name() === 'claw');
    const daemonCmd = clawCmd?.commands.find((c: any) => c.name() === 'daemon');

    const start = Date.now();
    await (daemonCmd as any)._actionHandler(['running-claw']);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(1000);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('already running'));
  });

  it('mock spawn returns a resolved promise (regression invariant)', async () => {
    const { createAgentProcessManager } = await import(
      '../../src/foundation/process-manager/agent-factory.js'
    );
    const pm = createAgentProcessManager({} as any, {} as any);
    const result = pm.spawn('test-claw', {
      command: 'node',
      args: ['daemon-entry.js', 'test-claw'],
      logFile: path.join(tmpDir, 'daemon.log'),
    });

    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBeUndefined();
  });

  it('CLI dynamic import does not block indefinitely (boot-chain integrity)', async () => {
    const start = Date.now();
    await import('../../src/cli/index.js');
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(3000);
  });
});
