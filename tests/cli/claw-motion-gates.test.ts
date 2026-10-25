/**
 * phase 1986 Step H：motion CLI 门类 verb 矩阵。
 *
 * health / daemon / stop / chat / trace 的存在性门对 motion 放行且目标位置为
 * <root>/motion。mock 只在 PM / viewport 边界；门与路径解析走产品代码。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { healthCommand } from '../../src/cli/commands/claw-health.js';
import { clawDaemonCommand, type DaemonPM } from '../../src/cli/commands/claw-daemon.js';
import { stopCommand } from '../../src/cli/commands/claw-stop.js';
import { chatCommand } from '../../src/cli/commands/claw-chat.js';
import { clawTraceCommand } from '../../src/cli/commands/claw-trace.js';
import { runChatViewport } from '../../src/viewport/index.js';
import { makeContractId } from '../../src/core/contract/index.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { createTrackedTempDir, cleanupTempDir } from '../utils/temp.js';

// ── 边界 mock：PM（不 spawn 真实 daemon）──────────────────────────────────────
const pmMocks = vi.hoisted(() => ({
  isAlive: vi.fn(() => false),
  spawn: vi.fn(),
  stop: vi.fn(),
}));

vi.mock('../../src/foundation/process-manager/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/foundation/process-manager/index.js')>()),
  createProcessManagerForCLI: vi.fn(() => pmMocks),
  signalCleanStop: vi.fn(),
  clearCleanStop: vi.fn(),
}));

// ── 边界 mock：chat viewport（不进真实 TUI）───────────────────────────────────
vi.mock('../../src/viewport/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/viewport/index.js')>()),
  runChatViewport: vi.fn(async () => {}),
  createViewportAudit: vi.fn(() => ({
    write: vi.fn(),
    preview: (s: string) => s,
    message: (s: string) => s,
    summary: (s: string) => s,
  })),
}));

describe('claw motion gates (phase 1986 Step H)', () => {
  let workspaceRoot: string;
  let chestnutRoot: string;
  let motionDir: string;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    workspaceRoot = await createTrackedTempDir('claw-motion-gates-1986-');
    chestnutRoot = path.join(workspaceRoot, '.chestnut');
    motionDir = path.join(chestnutRoot, 'motion');
    await fs.mkdir(path.join(motionDir, 'inbox', 'pending'), { recursive: true });
    await fs.mkdir(path.join(motionDir, 'outbox', 'pending'), { recursive: true });
    await fs.writeFile(path.join(chestnutRoot, 'config.yaml'), 'llm:\n  primary: {}\n');
    vi.stubEnv('CHESTNUT_ROOT', workspaceRoot);

    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    pmMocks.isAlive.mockClear().mockReturnValue(false);
    pmMocks.spawn.mockClear();
    pmMocks.stop.mockClear();
    vi.mocked(runChatViewport).mockClear();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await cleanupTempDir(workspaceRoot);
  });

  function deps() {
    return {
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
      rootConfig: {
        loadGlobal: vi.fn(() => ({ viewport: {} }) as never),
        loadClaw: vi.fn((configPath: string) =>
          existsSync(configPath) ? ({} as never) : undefined),
      },
    };
  }

  it('health → 门放行（不报不存在），输出目标名 motion', async () => {
    await healthCommand(deps(), 'motion');

    const out = consoleLogSpy.mock.calls.flat().join('\n');
    expect(out).toContain('Health Check: motion');
    expect(out).not.toContain('does not exist');
  });

  it('health → motion 目录缺失时 loud 报未初始化', async () => {
    await fs.rm(motionDir, { recursive: true, force: true });
    await expect(healthCommand(deps(), 'motion')).rejects.toThrow(/Motion is not initialized/);
  });

  it('daemon → PM alive 走 already running 分支；不 spawn；不报不存在', async () => {
    pmMocks.isAlive.mockReturnValue(true);

    const daemonDeps = {
      ...deps(),
      processManager: { isAlive: pmMocks.isAlive, spawn: pmMocks.spawn } as unknown as DaemonPM,
    };
    await clawDaemonCommand(daemonDeps, 'motion');

    const out = consoleWarnSpy.mock.calls.flat().join('\n');
    expect(out).toContain('Claw "motion" is already running');
    expect(pmMocks.spawn).not.toHaveBeenCalled();
  });

  it('stop → PM not alive → "is not running"；不报不存在', async () => {
    await stopCommand(deps(), 'motion');

    const out = consoleLogSpy.mock.calls.flat().join('\n');
    expect(out).toContain('Claw "motion" is not running');
  });

  // phase 1997 Step B：identity 改 typed clawId + ClawLocation；agentDir 由 location.clawDir 承担
  it('chat → viewport 收到的 location.clawDir 恰为 <root>/motion、kind 为 motion', async () => {
    await chatCommand(deps(), 'motion');

    expect(runChatViewport).toHaveBeenCalledTimes(1);
    const viewportArgs = vi.mocked(runChatViewport).mock.calls[0][0] as {
      clawId: string;
      location: { kind: string; clawDir: string };
      label: string;
    };
    expect(viewportArgs.location.clawDir).toBe(motionDir);
    expect(viewportArgs.location.kind).toBe('motion');
    expect(viewportArgs.clawId).toBe('motion');
  });

  it('trace → 不存在的 contract 报 not found（证明已过硬门、未读 claws/motion）', async () => {
    await expect(
      clawTraceCommand(deps(), 'motion', makeContractId('C-nonexistent')),
    ).rejects.toThrow(/Contract "C-nonexistent" not found for claw "motion"/);
    expect(existsSync(path.join(chestnutRoot, 'claws', 'motion'))).toBe(false);
  });
});
