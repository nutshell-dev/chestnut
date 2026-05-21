/**
 * @module L2.CommandTool
 *
 * CommandTool 工厂 / 把 L1 ProcessExec 包装成 1 个 Tool 协议对象。
 * 应然单源：design/modules/l2_command_tool.md
 * phase378 物理迁实施 / phase421 反向 rename align arch §17 + 表 1。
 */

import type { Tool } from '../tools/index.js';
import { createExecTool } from './exec.js';

/** CommandTool own sync scratch subdir（turn-scoped / Snapshot whitelist 清理）*/
export const TASKS_SYNC_EXEC_DIR = 'tasks/sync/exec';

export interface CommandToolModule {
  exec: Tool;
  // 后续：allowList / denyList 准入约束（design L40-49 / 推 r52+/r53+ 实装）
}

export interface CommandToolDeps {
  /** 进程执行依赖（应然 L1 ProcessExec interface 注入） */
  processExec?: unknown;  // 当前简化 / 推 r52+ port 化
  /** 命令白名单（推 r52+/r53+ 实装） */
  allowList?: ReadonlyArray<string>;
  /** 命令黑名单（推 r52+/r53+ 实装） */
  denyList?: ReadonlyArray<string>;
  /** 默认超时（毫秒）/ 推 r52+/r53+ 实装 */
  defaultTimeoutMs?: number;
}

/**
 * 创建 CommandTool 模块
 * 
 * 当前简化版：execTool 单例直 export / processExec 经 module-level import
 * 推 r52+/r53+ port 化（参 phase348 WatchdogObserver port 模板）
 */
export function createCommandTools(deps: CommandToolDeps = {}): CommandToolModule {
  return { exec: createExecTool(deps) };
}

export { createExecTool, execTool } from './exec.js';
export { EXEC_TOOL_NAME } from '../tools/tool-names.js';
