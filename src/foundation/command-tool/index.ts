/**
 * @module L2.CommandTool
 *
 * CommandTool 工厂 / 把 L1 ProcessExec 包装成 1 个 Tool 协议对象。
 * 应然单源：design/modules/l2_command_tool.md
 * phase378 物理迁实施 / phase421 反向 rename align arch §17 + 表 1。
 *
 * phase 1280 r136 B: REFRAMED-OUT by-design 2026-05-25 user ratify —
 * CommandTool 不做 application-level 权限管理 / 未来走 OS-level sandbox.
 * 详 design §A.r136-cmd-tool-no-perm-mgmt-cleanup +
 *    project memory project_command_tool_no_perm.md。
 */

import type { Tool } from '../tools/index.js';
import { createExecTool } from './exec.js';

export interface CommandToolModule {
  exec: Tool;
}

export { TASKS_SYNC_EXEC_DIR } from './constants.js';

/**
 * 创建 CommandTool 模块
 */
export function createCommandTools(): CommandToolModule {
  return { exec: createExecTool() };
}

export { createExecTool, execTool } from './exec.js';
export { EXEC_TOOL_NAME } from './exec.js';
