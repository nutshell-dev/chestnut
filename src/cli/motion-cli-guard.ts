/**
 * @module L6.CLI.MotionCliGuard
 *
 * phase 1986 Step G：motion CLI 调用者守卫。
 *
 * 机制：CommandTool 每次 agent exec 向子进程 env 注入 CHESTNUT_CALLER_AGENT_ID
 * （主代理=claw id，子代理=task id）。CLI 唯一入口在解析 argv 前 capture 并
 * 删除该 env（CLI 自己 spawn 的 daemon/watchdog 不继承 marker）。一个
 * commander preAction 全局钩子按已解析的命令形状判定「本命令是否操作
 * motion」，在 action / supervision / audit scope 之前拒绝非授权调用者：
 * - 无 marker（用户终端）→ 放行；
 * - marker === motion（motion 主代理）→ 放行；
 * - 其他值（任一其他 claw / 子代理）→ CliError，非零退出，无 motion 副作用。
 *
 * 边界：这是应用层身份守卫，不是安全沙箱；agent 显式篡改 env 仍可绕过，
 * 更强边界归 OS sandbox。
 */

import type { Command } from 'commander';
import { CALLER_AGENT_ID_ENV } from '../foundation/command-tool/index.js';
import { MOTION_CLAW_ID } from '../core/claw-topology/index.js';
import { CliError } from './errors.js';
import { withCliErrorHandling } from './with-cli-error-handling.js';

let capturedCallerAgentId: string | undefined;

/**
 * CLI 唯一入口调用：读取 caller marker 后立即从 process.env 删除。
 * 删除保证本进程 spawn 的 daemon/watchdog 不继承 agent 身份。
 */
export function captureCliCallerIdentity(): void {
  capturedCallerAgentId = process.env[CALLER_AGENT_ID_ENV];
  delete process.env[CALLER_AGENT_ID_ENV];
}

/** 注册全局 preAction 钩子（在 action / supervision / audit scope 之前）。 */
export function registerMotionCliGuard(program: Command): void {
  program.hook('preAction', withCliErrorHandling((_thisCommand, actionCommand) => {
    assertMotionCliAccessAllowed(actionCommand);
  }));
}

export function assertMotionCliAccessAllowed(command: Command): void {
  // fallback 覆盖「测试/未来入口未调 capture」；真实 CLI 入口已删除 env，正常走 captured。
  const caller = capturedCallerAgentId ?? process.env[CALLER_AGENT_ID_ENV];
  if (caller === undefined || caller === MOTION_CLAW_ID) return;
  if (!commandTargetsMotion(command)) return;
  throw new CliError(
    'this command can affect motion and can only be invoked by the user; ' +
    `agent-initiated CLI calls (caller=${caller}) are not allowed.`,
  );
}

function commandTargetsMotion(command: Command): boolean {
  const path = commandPath(command);

  // Both families read or affect motion without an explicit --claw option.
  // Launcher setup also changes the global configuration used by motion.
  if (path[0] === MOTION_CLAW_ID || path[0] === 'launcher') return true;
  // 初始化会发布 motion 共用的全局配置与 Watchdog 布局。
  if (path.length === 1 && (path[0] === 'stop' || path[0] === 'start' || path[0] === 'init')) return true;

  // Watchdog start/stop directly control motion supervision.
  if (path[0] === 'watchdog') return true;

  // Dispatch repository, edit workspaces and state all live in motion/clawspace.
  if (path[0] === 'dispatch-skill') return true;

  // Provider 写操作改变 motion 共用的配置或凭据；只读 list 仍可共享。
  if (path.length === 3 && path[0] === 'config' && path[1] === 'provider'
    && ['add', 'remove', 'set-primary', 'move', 'login', 'logout'].includes(path[2]!)) return true;

  // 任意命令的 --claw motion（contract / skill / audit / 未来命令）
  const opts = command.opts() as { claw?: unknown };
  if (opts.claw === MOTION_CLAW_ID) return true;

  // claw motion <verb>；help 放行
  if (path.length === 1 && path[0] === 'claw') {
    const args = command.args as string[];
    if (args[0] !== MOTION_CLAW_ID) return false;
    const rest = args.slice(1);
    return !(rest.includes('--help') || rest.includes('-h'));
  }

  // skill install / skill list 的 --claw 缺省目标 = motion（misc-command-catalog 明示）；
  // 显式 --claw <other> 时目标不是 motion，放行。
  const joined = path.join('/');
  if (joined === 'skill/install' || joined === 'skill/list') {
    return opts.claw === undefined;
  }
  return false;
}

function commandPath(command: Command): string[] {
  const path: string[] = [];
  let current: Command | null = command;
  while (current && current.parent) {
    path.unshift(current.name());
    current = current.parent;
  }
  return path;
}
