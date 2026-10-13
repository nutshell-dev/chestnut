/**
 * Phase 1936 Step C：claw chat 使用 ProcessManager `ensureRunning`。
 *
 * - ensureDaemon 回调调用 pm.ensureRunning（daemonDir + Daemon-owned spawn
 *   specification），不再组合 isAlive()+spawn()（TOCTOU / 第二套启动语义）；
 * - joined outcome（合法 spawning winner 收敛）不向调用方抛竞争异常；
 * - typed failure（ProcessWinnerConvergenceError）原样上抛，供 viewport 呈现；
 * - 源码结构：无 isAlive+spawn check-then-spawn 组合、无 console.log 启动文案
 *   （显示归 viewport owner）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const h = vi.hoisted(() => ({
  runChatViewport: vi.fn(),
  createViewportAudit: vi.fn(),
  ensureRunning: vi.fn(),
  createProcessManagerForCLI: vi.fn(),
}));

vi.mock('../../src/viewport/index.js', () => ({
  runChatViewport: h.runChatViewport,
  createViewportAudit: h.createViewportAudit,
}));

vi.mock('../../src/foundation/process-manager/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/process-manager/index.js')>();
  return {
    ...actual,
    createProcessManagerForCLI: h.createProcessManagerForCLI,
  };
});

import { chatCommand } from '../../src/cli/commands/claw-chat.js';
import { makeClawCommandDeps } from '../helpers/claw-command-deps.js';
import { resolveClawDaemonDir } from '../../src/core/claw-topology/index.js';
import { makeClawId } from '../../src/foundation/claw-identity/index.js';
import { ProcessWinnerConvergenceError } from '../../src/foundation/process-manager/index.js';
import { testClawDaemonDir } from '../helpers/daemon-dir.js';
import type { ChatViewportOptions } from '../../src/viewport/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clawChatSource = fs.readFileSync(
  path.join(__dirname, '../../src/cli/commands/claw-chat.ts'),
  'utf-8',
);

const VALID_GLOBAL = {
  viewport: {
    show_recap_stream: false,
    show_system_messages: false,
    show_contract_events: true,
    trim_output_newlines: true,
    user_input_inline_max_chars: 2000,
  },
};

async function captureViewportOptions(): Promise<ChatViewportOptions> {
  // fsFactory 在 createViewportAudit 调用点被立即求值（mock 之前），提供惰性桩
  const deps = makeClawCommandDeps(
    () => ({}) as any,
    { loadGlobal: () => VALID_GLOBAL as any },
  );
  h.runChatViewport.mockResolvedValue(undefined);
  h.createViewportAudit.mockReturnValue({ write: vi.fn() });
  await chatCommand(deps, 'alice');
  expect(h.runChatViewport).toHaveBeenCalledTimes(1);
  return h.runChatViewport.mock.calls[0][0] as ChatViewportOptions;
}

describe('phase 1936 Step C — claw chat ensureDaemon 经 ensureRunning', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.createProcessManagerForCLI.mockReturnValue({ ensureRunning: h.ensureRunning });
  });

  it('ensureDaemon 以 exact daemonDir + Daemon-owned spawn options 调用 ensureRunning', async () => {
    h.ensureRunning.mockResolvedValue({ kind: 'spawned', pid: 4321 });
    const options = await captureViewportOptions();
    await options.ensureDaemon!();

    expect(h.ensureRunning).toHaveBeenCalledTimes(1);
    const [daemonDir, spawnOptions] = h.ensureRunning.mock.calls[0];
    expect(daemonDir).toBe(resolveClawDaemonDir(makeClawId('alice')));
    // spawn specification 归 Daemon owner（createDaemonSpawnOptions 产物）
    expect(spawnOptions).toMatchObject({ command: 'node' });
    expect(spawnOptions.env.CHESTNUT_ROOT).toBeDefined();
  });

  it('joined outcome（合法 spawning winner 收敛）正常 resolve、不抛竞争异常', async () => {
    h.ensureRunning.mockResolvedValue({
      kind: 'joined',
      pid: 4321,
      generationId: '14c97dda-3cc7-4898-a5f0-5631d68c9985',
    });
    const options = await captureViewportOptions();
    await expect(options.ensureDaemon!()).resolves.toBeUndefined();
  });

  it('typed convergence failure 原样上抛（同一实例），供 viewport 呈现', async () => {
    const typed = new ProcessWinnerConvergenceError(
      testClawDaemonDir('/tmp/phase1936', 'alice'),
      'winner_vanished',
      '14c97dda-3cc7-4898-a5f0-5631d68c9985',
      'Winner generation 14c97dda did not converge to ready (winner_vanished: ...)',
    );
    h.ensureRunning.mockRejectedValue(typed);
    const options = await captureViewportOptions();
    await expect(options.ensureDaemon!()).rejects.toBe(typed);
  });
});

describe('phase 1936 Step C — claw-chat 源码结构', () => {
  it('不再组合 isAlive()+spawn()，改用 ensureRunning', () => {
    expect(clawChatSource).not.toMatch(/\.isAlive\(/);
    expect(clawChatSource).not.toMatch(/\.spawn\(/);
    expect(clawChatSource).toMatch(/\.ensureRunning\(/);
  });

  it('不再 console.log 启动文案（显示归 viewport owner）', () => {
    // 剥离注释后断言（块注释保换行、行注释删除）
    const stripped = clawChatSource
      .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
      .replace(/(^|[^:])\/\/[^\n]*/g, (_m, prefix) => prefix as string);
    expect(stripped).not.toMatch(/console\.log/);
  });
});
