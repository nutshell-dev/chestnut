/**
 * Phase 1936 Step B：viewport 先可见 + daemon 保障后台 task。
 *
 * 行为断言（chat-viewport-daemon-ensure controller）：
 * - pending：构造即渲染启动中系统消息 + DAEMON_ENSURE_STARTED audit；
 * - ready：ensure resolve → state ready + DAEMON_ENSURE_READY audit + ✓ 消息；
 * - failed：ensure reject（typed ProcessWinnerConvergenceError）→ state failed +
 *   DAEMON_ENSURE_FAILED audit 携带 typed reason + 失败系统消息含 reason；
 *   settled 不 reject（无 unhandled rejection）。
 *
 * 结构断言（chat-viewport.ts 装配）：
 * - 不再 `await options.ensureDaemon()`（TUI 构造前无 daemon 硬门槛）；
 * - ensure task 装配在 `tui.start()` 之后（viewport 先可见）；
 * - onSubmit 在写 inbox 前门控 daemonEnsure failed 终态（消息不静默丢失）。
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { createDaemonEnsureController } from '../../src/viewport/chat-viewport-daemon-ensure.js';
import { VIEWPORT_AUDIT_EVENTS } from '../../src/viewport/viewport-audit-events.js';
import { ProcessWinnerConvergenceError } from '../../src/foundation/process-manager/index.js';
import { testClawDaemonDir } from '../helpers/daemon-dir.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const viewportSource = fs.readFileSync(
  path.join(__dirname, '../../src/viewport/chat-viewport.ts'),
  'utf-8',
);

function makeHarness(ensureDaemon: () => Promise<void>) {
  const messages: Array<{ color: string; text: string }> = [];
  const auditWrite = vi.fn();
  const controller = createDaemonEnsureController({
    label: 'rea',
    ensureDaemon,
    audit: { write: auditWrite } as any,
    appendOutput: (color, text) => { messages.push({ color, text }); },
    requestRender: () => {},
  });
  return { controller, messages, auditWrite };
}

describe('phase 1936 Step B — daemon ensure 受控后台 task', () => {
  it('构造即 pending：启动中系统消息 + STARTED audit', () => {
    const { controller, messages, auditWrite } = makeHarness(() => new Promise<void>(() => {}));
    expect(controller.state()).toBe('pending');
    expect(messages.some(m => m.text.includes('daemon'))).toBe(true);
    expect(auditWrite).toHaveBeenCalledWith(
      VIEWPORT_AUDIT_EVENTS.DAEMON_ENSURE_STARTED,
      'label=rea',
    );
  });

  it('ensure resolve → ready：READY audit + ✓ 消息，settled 正常结算', async () => {
    const { controller, messages, auditWrite } = makeHarness(() => Promise.resolve());
    await controller.settled;
    expect(controller.state()).toBe('ready');
    expect(auditWrite).toHaveBeenCalledWith(
      VIEWPORT_AUDIT_EVENTS.DAEMON_ENSURE_READY,
      'label=rea',
    );
    expect(messages.some(m => m.text.includes('✓ Daemon ready'))).toBe(true);
  });

  it('ensure reject（typed convergence failure）→ failed：reason 可观察、settled 不 reject', async () => {
    const typed = new ProcessWinnerConvergenceError(
      testClawDaemonDir('/tmp/phase1936', 'rea'),
      'winner_failed',
      '14c97dda-3cc7-4898-a5f0-5631d68c9985',
      'Winner generation 14c97dda did not converge to ready (winner_failed: failure fact: boot died)',
    );
    const { controller, messages, auditWrite } = makeHarness(() => Promise.reject(typed));
    // settled 必须 resolve（不 reject）——handlers 构造时已附着，无 unhandled rejection
    await expect(controller.settled).resolves.toBeUndefined();
    expect(controller.state()).toBe('failed');
    expect(auditWrite).toHaveBeenCalledWith(
      VIEWPORT_AUDIT_EVENTS.DAEMON_ENSURE_FAILED,
      'label=rea',
      expect.stringContaining('winner_failed'),
    );
    // 系统消息包含 typed reason（不压平成通用文案）
    expect(messages.some(m => m.text.includes('✗ Daemon 启动失败') && m.text.includes('winner_failed'))).toBe(true);
  });
});

describe('phase 1936 Step B — runChatViewport 装配顺序', () => {
  it('不再在 TUI 构造前 await ensureDaemon', () => {
    expect(viewportSource).not.toMatch(/await\s+options\.ensureDaemon\(/);
  });

  it('ensure task 装配在 tui.start() 之后（viewport 先可见）', () => {
    const tuiStartIdx = viewportSource.indexOf('tui.start();');
    const ensureIdx = viewportSource.indexOf('createDaemonEnsureController({');
    expect(tuiStartIdx).toBeGreaterThanOrEqual(0);
    expect(ensureIdx).toBeGreaterThan(tuiStartIdx);
  });

  it('onSubmit 在写 inbox 前门控 daemonEnsure failed 终态', () => {
    const gateIdx = viewportSource.indexOf("daemonEnsure?.state() === 'failed'");
    const submitIdx = viewportSource.indexOf('submitUserMessage(');
    expect(gateIdx).toBeGreaterThanOrEqual(0);
    expect(submitIdx).toBeGreaterThan(gateIdx);
  });
});
