/**
 * @module L6.Viewport.DaemonEnsure
 * Phase 1936 Step B/C：daemon 保障动作（ensureDaemon）的受控后台 task。
 *
 * chat 的主动作是建立并运行可见 viewport；daemon 启动是系统保障动作。
 * 本 controller 在 viewport 可见宿主（TUI/stream/cleanup）建立之后运行调用方
 * 注入的 ensure 能力（推荐 ProcessManager `ensureRunning`）：
 * - pending / ready / failed 三态显式可观察（系统消息 + audit 事件）；
 * - ensure rejection 永不变成无 UI 的 CLI 异常，也不阻止 viewport 构造与清理；
 * - failed 终态由 runChatViewport 用于输入提交门控——不写 inbox（无消费者）、
 *   文本回填编辑器，消息不静默丢失；pending 期间 inbox 写入持久、daemon
 *   ready 后消费，保持既有 "(pending)" 语义。
 *
 * 边界：本模块不解释 generation 状态、不组装 daemon 启动协议（归
 * ProcessManager / Daemon owner），只消费注入 ensure 能力的 settle 结果并
 * 呈现 typed reason。
 */

import { formatErr } from '../foundation/node-utils/index.js';
import type { AuditLog } from '../foundation/audit/index.js';
import { VIEWPORT_AUDIT_EVENTS } from './viewport-audit-events.js';

export type DaemonEnsureState = 'pending' | 'ready' | 'failed';

export interface DaemonEnsureController {
  /** 当前保障状态：pending=确认/启动中，ready=可用，failed=启动失败（终态，可审计）。 */
  state(): DaemonEnsureState;
  /**
   * ensure task 的 settled 信号。handlers 在构造时即附着——不 reject、
   * 不产生 unhandled rejection；供测试与退出路径观察，不用于阻塞退出
   * （ensureRunning ready 等待上限 BOOT_DEADLINE_MS=30s 远超可感知退出延迟，
   * generation/ensure 的持久证据归 ProcessManager audit）。
   */
  readonly settled: Promise<void>;
}

export function createDaemonEnsureController(deps: {
  label: string;
  ensureDaemon: () => Promise<void>;
  audit: AuditLog;
  appendOutput: (color: string, text: string, wrap?: boolean) => void;
  requestRender: () => void;
}): DaemonEnsureController {
  let state: DaemonEnsureState = 'pending';

  deps.appendOutput('\x1b[36m', `⟳ 正在确认 ${deps.label} daemon 状态…`, true);
  try {
    deps.audit.write(VIEWPORT_AUDIT_EVENTS.DAEMON_ENSURE_STARTED, `label=${deps.label}`);
  } catch { /* silent: audit self-failure tolerated */ }

  const settled = (async () => {
    try {
      await deps.ensureDaemon();
      state = 'ready';
      try {
        deps.audit.write(VIEWPORT_AUDIT_EVENTS.DAEMON_ENSURE_READY, `label=${deps.label}`);
      } catch { /* silent: audit self-failure tolerated */ }
      deps.appendOutput('\x1b[32m', '✓ Daemon ready', true);
    } catch (err) {
      state = 'failed';
      // typed reason 原样呈现（ProcessWinnerConvergenceError 等携带 generation/reason），
      // 不按错误文本压平或重试——收敛语义归 ProcessManager。
      const reason = formatErr(err);
      try {
        deps.audit.write(
          VIEWPORT_AUDIT_EVENTS.DAEMON_ENSURE_FAILED,
          `label=${deps.label}`,
          `reason=${reason}`,
        );
      } catch { /* silent: audit self-failure tolerated */ }
      deps.appendOutput('\x1b[31m', `✗ Daemon 启动失败：${reason}`, true);
      deps.appendOutput('\x1b[31m', '  daemon 不可用期间消息不会发送；可退出后重试，详见 audit。', true);
    }
    deps.requestRender();
  })();

  return {
    state: () => state,
    settled,
  };
}
