/**
 * @module L4.SpawnSystem
 * spawn-system module exports.
 *
 * 业务语义：一次性 sub-agent 任务委派（async 路径 / Phase Y 可扩 sync 路径）。
 * 依赖：async-task-system（async 路径 / writePendingSubagentTaskFile）。
 *
 * 见 design/modules/l4_spawn_system.md。
 */

export { spawnTool, SPAWN_TOOL_NAME } from './tools/spawn.js';
export { SPAWN_AUDIT_EVENTS } from './audit-events.js';
export { TASKS_SYNC_SPAWN_DIR } from './constants.js';
