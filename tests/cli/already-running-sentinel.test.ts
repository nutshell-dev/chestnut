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
import { createTrackedTempDir, cleanupTempDir } from '../utils/temp.js';
import { clawDaemonCommand, type DaemonPM } from '../../src/cli/commands/claw-daemon.js';
import { motionDaemonCommand } from '../../src/cli/commands/motion-daemon.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { CliError } from '../../src/cli/errors.js';
import { makeClawCommandDeps } from '../helpers/claw-command-deps.js';
import { CLI_AUDIT_EVENTS } from '../../src/cli/audit-events.js';

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

  beforeEach(async () => {
    tmpDir = await createTrackedTempDir('chestnut-ar-test-');
    originalRoot = process.env.CHESTNUT_ROOT;
    process.env.CHESTNUT_ROOT = tmpDir;
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    setupConfig();
  });

  afterEach(async () => {
    warnSpy.mockRestore();
    logSpy.mockRestore();
    if (originalRoot === undefined) delete process.env.CHESTNUT_ROOT;
    else process.env.CHESTNUT_ROOT = originalRoot;
    await cleanupTempDir(tmpDir);
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

  /** Fake pm for the spawn-success path (phase 1452 Step B audit emit tests). */
  function deadFakePM(pid = 4321): DaemonPM {
    return {
      isAlive: () => false,
      spawn: () => Promise.resolve(pid),
    };
  }

  function daemonDeps(options: Parameters<typeof makeClawCommandDeps>[1] = {}) {
    return { ...makeClawCommandDeps(fsFactory, options), processManager: aliveFakePM() };
  }

  it('clawDaemonCommand warns ⚠ when isAlive=true', async () => {
    setupClaw('running-claw');
    await clawDaemonCommand(daemonDeps(), 'running-claw');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('⚠'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('already running'));
  });

  it('motionDaemonCommand warns ⚠ when isAlive=true', async () => {
    await motionDaemonCommand({ fsFactory, rootConfig: { loadGlobal: vi.fn() }, processManager: aliveFakePM() });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('⚠'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('already running'));
  });

  it('motionDaemonCommand propagates global config failure before process inspection', async () => {
    const sentinel = new Error('motion daemon config sentinel');
    const processManager = aliveFakePM();
    const isAliveSpy = vi.spyOn(processManager, 'isAlive');

    await expect(motionDaemonCommand({
      fsFactory,
      rootConfig: { loadGlobal: () => { throw sentinel; } },
      processManager,
    })).rejects.toBe(sentinel);
    expect(isAliveSpy).not.toHaveBeenCalled();
  });

  it('clawDaemonCommand throws CliError when claw does not exist (no static fallthrough)', async () => {
    await expect(
      clawDaemonCommand(daemonDeps({ loadClaw: () => undefined }), 'ghost-claw'),
    ).rejects.toBeInstanceOf(CliError);
  });

  it('clawDaemonCommand happy-path early-return completes in <500ms', async () => {
    setupClaw('running-claw');
    const start = Date.now();
    await clawDaemonCommand(daemonDeps(), 'running-claw');
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(EARLY_RETURN_UPPER_BOUND_MS);
  });

  it('clawDaemonCommand emits CLI_AUDIT CLAW_DAEMON_START after successful spawn (phase 1452 Step B)', async () => {
    setupClaw('new-claw');
    const audit = { write: vi.fn() };
    await clawDaemonCommand(
      { ...makeClawCommandDeps(fsFactory), processManager: deadFakePM(4321) },
      'new-claw',
      { audit: audit as any },
    );
    expect(audit.write).toHaveBeenCalledWith(
      CLI_AUDIT_EVENTS.CLAW_DAEMON_START,
      'claw=new-claw',
      'pid=4321',
    );
  });

  it('motionDaemonCommand emits CLI_AUDIT MOTION_DAEMON_START after successful spawn (phase 1452 Step B)', async () => {
    const audit = { write: vi.fn() };
    await motionDaemonCommand(
      { fsFactory, rootConfig: { loadGlobal: vi.fn() }, processManager: deadFakePM(5678) },
      { audit: audit as any },
    );
    expect(audit.write).toHaveBeenCalledWith(
      CLI_AUDIT_EVENTS.MOTION_DAEMON_START,
      'pid=5678',
    );
  });

  it('DaemonPM shape invariant — fake pm satisfies the structural contract', () => {
    const pm: DaemonPM = aliveFakePM();
    expect(typeof pm.isAlive).toBe('function');
    expect(typeof pm.spawn).toBe('function');
    expect(pm.isAlive('whatever-id' as any)).toBe(true);
  });

  it('clawDaemonCommand propagates global config failure before loadClaw', async () => {
    const sentinel = new Error('global config sentinel');
    const deps = daemonDeps({ loadGlobal: () => { throw sentinel; } });
    await expect(clawDaemonCommand(deps, 'running-claw')).rejects.toBe(sentinel);
    expect(deps.rootConfig.loadClaw).not.toHaveBeenCalled();
  });

  it('clawDaemonCommand propagates claw config failure unchanged', async () => {
    const sentinel = new Error('claw config sentinel');
    const deps = daemonDeps({ loadClaw: () => { throw sentinel; } });
    await expect(clawDaemonCommand(deps, 'running-claw')).rejects.toBe(sentinel);
    expect(deps.processManager.isAlive).toBeDefined();
  });
});
