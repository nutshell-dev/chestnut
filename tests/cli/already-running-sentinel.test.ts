/**
 * already-running sentinel (phase 981 E-α3, retreated phase 1421)
 *
 * phase 1421: rewritten to call extracted `clawDaemonCommand` /
 * `motionDaemonCommand` directly with a fake processManager via DI, instead of
 * `vi.mock`-ing the agent-factory module under a commander action handler.
 * Root cause of prior flake: `vi.mock` of dynamic `await import()` was
 * intermittently bypassed under high concurrent ESM load, letting real
 * ProcessManager.spawn fall through (15s ready-poll hang for claw / process.exit
 * for motion). DI removes that dependency.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { clawDaemonCommand, type DaemonPM } from '../../src/cli/commands/claw-daemon.js';
import { motionDaemonCommand } from '../../src/cli/commands/motion-daemon.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { CliError } from '../../src/cli/errors.js';

/**
 * Early-return upper bound (ms) for clawDaemonCommand happy path.
 * Derivation: DI fake processManager 0 真 syscall / clawDaemonCommand 应 < 100ms 完成 /
 * 500ms = ×5 safety / 留出 vitest setup overhead jitter.
 */
const EARLY_RETURN_UPPER_BOUND_MS = 500;

const fsFactory = (baseDir: string) => new NodeFileSystem({ baseDir });

describe('already-running sentinel (phase 981 E-α3 / phase 1421 DI)', () => {
  let tmpDir: string;
  let originalRoot: string | undefined;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chestnut-ar-test-'));
    originalRoot = process.env.CHESTNUT_ROOT;
    process.env.CHESTNUT_ROOT = tmpDir;
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    setupConfig();
  });

  afterEach(() => {
    warnSpy.mockRestore();
    logSpy.mockRestore();
    if (originalRoot === undefined) delete process.env.CHESTNUT_ROOT;
    else process.env.CHESTNUT_ROOT = originalRoot;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function setupConfig() {
    const configPath = path.join(tmpDir, '.chestnut', 'config.yaml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      'version: "1"\nllm:\n  primary:\n    preset: anthropic\n    api_key: test\n    model: claude\n    max_tokens: 4096\n    temperature: 0.7\n    timeout_ms: 60000\n  retry_attempts: 3\n  retry_delay_ms: 1000\n',
    );
  }

  function setupClaw(name: string) {
    const clawDir = path.join(tmpDir, '.chestnut', 'claws', name);
    fs.mkdirSync(clawDir, { recursive: true });
    fs.writeFileSync(path.join(clawDir, 'config.yaml'), `name: ${name}\n`);
  }

  /** Fake pm that always reports the agent as alive — `spawn` must never be reached. */
  function aliveFakePM(): DaemonPM {
    return {
      isAlive: () => true,
      spawn: () => {
        throw new Error('spawn should not be invoked when isAlive=true');
      },
    };
  }

  it('clawDaemonCommand warns ⚠ when isAlive=true', async () => {
    setupClaw('running-claw');
    await clawDaemonCommand({ fsFactory, processManager: aliveFakePM() }, 'running-claw');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('⚠'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('already running'));
  });

  it('motionDaemonCommand warns ⚠ when isAlive=true', async () => {
    await motionDaemonCommand({ fsFactory, processManager: aliveFakePM() });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('⚠'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('already running'));
  });

  it('clawDaemonCommand throws CliError when claw does not exist (no static fallthrough)', async () => {
    await expect(
      clawDaemonCommand({ fsFactory, processManager: aliveFakePM() }, 'ghost-claw'),
    ).rejects.toBeInstanceOf(CliError);
  });

  it('clawDaemonCommand happy-path early-return completes in <500ms', async () => {
    setupClaw('running-claw');
    const start = Date.now();
    await clawDaemonCommand({ fsFactory, processManager: aliveFakePM() }, 'running-claw');
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(EARLY_RETURN_UPPER_BOUND_MS);
  });

  it('DaemonPM shape invariant — fake pm satisfies the structural contract', () => {
    const pm: DaemonPM = aliveFakePM();
    expect(typeof pm.isAlive).toBe('function');
    expect(typeof pm.spawn).toBe('function');
    expect(pm.isAlive('whatever-id' as any)).toBe(true);
  });
});
