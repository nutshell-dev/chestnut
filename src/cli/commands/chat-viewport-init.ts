/**
 * Session initialization from history + process-level uncaught error handler
 * What: replay historical stream events to restore turn state, and terminal-safe crash handler
 * When: viewport startup (history replay) and runtime uncaught exceptions
 * Why: session repair logic and crash handling evolve independently of display/event dispatch
 */

import { createSystemAudit } from '../../foundation/audit/index.js';
import { NodeFileSystem } from '../../foundation/fs/node-fs.js';
import { CLI_AUDIT_EVENTS } from '../audit-events.js';
import { VIEWPORT_AUDIT_EVENTS } from './viewport-audit-events.js';
import type { FileSystem } from '../../foundation/fs/types.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { TurnTracker } from './chat-viewport.js';

export interface UncaughtHandlerDeps {
  agentDir: string;
  fs: FileSystem;
  tui: { stop(): void };
  crashLogPath: string;
  audit: AuditLog;
}

export function createUncaughtHandler(deps: UncaughtHandlerDeps) {
  return function uncaughtHandler(err: unknown): void {
    // sync audit emit via motion-level audit shim（process 即将 exit、必 sync）
    // fail-soft：shim 构造或 write 失败回退 stderr-only、不抛
    try {
      const shim = createSystemAudit(
        new NodeFileSystem({ baseDir: deps.agentDir }),
        deps.agentDir,
      );
      const errMsg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      const stack = err instanceof Error && err.stack ? err.stack.split('\n').slice(0, 5).join(' | ') : '';
      shim?.write(
        CLI_AUDIT_EVENTS.CHAT_CRASH_UNCAUGHT,
        `pid=${process.pid}`,
        `error=${errMsg}`,
        stack ? `stack_head=${stack}` : '',
      );
    } catch { /* silent: shim self-failure should not break crash log + stderr path */ }

    // 写入崩溃日志文件（terminal 关闭后仍可读）
    try {
      const stack = (err instanceof Error) ? err.stack : String(err);
      deps.fs.appendSync(deps.crashLogPath, `\n[${new Date().toISOString()}] uncaught:\n${stack}\n`);
    } catch { /* silent: crash log append best-effort / 已 console.error 输出 / 不阻断 exit */ }
    process.stderr.write(`[chat] uncaught error: ${err}\n`);
    try { deps.tui.stop(); } catch { /* silent: tui.stop best-effort / already in shutdown / 不阻断 exit */ }
    // 刷新 stdout 后再退出，防止 escape sequences 被截断触发 Terminal.app crash
    process.stdout.write('', () => { process.exitCode = 1; process.exit(1); });
  };
}

export interface InitOwnStateDeps {
  isMotion: boolean;
  fs: FileSystem;
  streamPath: string;
  turnTracker: TurnTracker;
  audit: AuditLog;
}

/** 重连时从历史 stream 初始化自身状态（仅非 motion 调用） */
export function initOwnStateFromHistory(deps: InitOwnStateDeps): void {
  if (deps.isMotion) return;
  try {
    const stat = deps.fs.statSync(deps.streamPath);
    if (stat.size === 0) return;
    const buf = deps.fs.readBytesSync(deps.streamPath, 0, stat.size);
    const lines = buf.toString('utf-8').split('\n');
    lines.pop(); // 末尾不完整行
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'turn_start')       { deps.turnTracker.begin(); }
        else if (ev.type === 'turn_end' || ev.type === 'turn_interrupted' || ev.type === 'turn_error') {
          deps.turnTracker.forceReset();
        }
      } catch { /* silent: skip malformed JSON line in history replay */ }
    }
  } catch (err) {
    // phase 904 / audit-2026-05-16 P2 site 2: 分流 ENOENT silent vs 其他 audit emit
    const code = (err as { code?: string })?.code;
    if (code !== 'ENOENT') {
      deps.audit.write(VIEWPORT_AUDIT_EVENTS.HISTORY_REPLAY_FAILED, `error=${String(err)}`, `code=${code ?? 'unknown'}`);
    }
  }
}
