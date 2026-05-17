import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Prevent program.parse() from executing during module load
vi.mock('commander', async () => {
  const mod = await vi.importActual<typeof import('commander')>('commander');
  const program = new mod.Command();
  program.parse = vi.fn(() => program);
  program.parseAsync = vi.fn(() => Promise.resolve(program));
  return { ...mod, program };
});

vi.mock('../../src/foundation/process-manager/agent-factory.js', () => ({
  createAgentProcessManager: vi.fn(() => ({
    isAlive: vi.fn(() => true),
    spawn: vi.fn(),
  })),
}));

describe('already-running sentinel (phase 981 E-α3)', () => {
  let tmpDir: string;
  let originalRoot: string | undefined;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
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
});
