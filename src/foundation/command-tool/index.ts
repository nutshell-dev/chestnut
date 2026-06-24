/**
 * @module L2c.CommandTool
 *
 * CommandTool 工厂 / 把 L1 ProcessExec 包装成 1 个 Tool 协议对象。
 * 应然单源：design/modules/l2_command_tool.md
 * phase378 物理迁实施 / phase421 反向 rename align arch §17 + 表 1。
 *
 * phase 1280 r136 B: REFRAMED-OUT by-design 2026-05-25 user ratify —
 * CommandTool 不做 application-level 权限管理 / 未来走 OS-level sandbox.
 * 详 design §A.r136-cmd-tool-no-perm-mgmt-cleanup +
 *    project memory project_command_tool_no_perm.md。
 *
 * phase 1473 motion-self-kill guard 豁免说明：exec.ts §guard
 * （`looksLikeChestnutSelfKill` + isMotionChain 拒绝路径）与上述
 * REFRAMED-OUT 不冲突。范畴区分：
 *   - REFRAMED-OUT 针对「用户该不该跑某命令」的授权语义（allow/deny list）
 *   - self-kill guard 针对「命令会不会杀死自己的 runtime」的存活语义
 * guard 严格限定 ctx.isMotionChain、scope 极窄（单条正则），不构成
 * application-level 权限管理框架，亦不与未来 OS-level sandbox 冲突。
 */

import type { Tool } from '../tools/index.js';
import { createExecTool } from './exec.js';

export interface CommandToolModule {
  exec: Tool;
}

export { TASKS_SYNC_EXEC_DIR, EXEC_MAX_OUTPUT } from './constants.js';

/**
 * 创建 CommandTool 模块
 */
export function createCommandTools(): CommandToolModule {
  return { exec: createExecTool() };
}

export { createExecTool, execTool } from './exec.js';
export { EXEC_TOOL_NAME } from './exec.js';
