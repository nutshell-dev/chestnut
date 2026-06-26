/**
 * @module L4.SpawnSystem
 * spawn-system module exports.
 *
 * 业务语义：一次性 sub-agent 任务委派（async 路径 + phase 766 sync 路径）。
 * 依赖：async-task-system（async 路径 / AsyncTaskSystem.schedule）。
 *
 * 见 design/modules/l4_spawn_system.md。
 */

export { spawnTool, createSpawnTool, SPAWN_TOOL_NAME } from './tools/spawn.js';
export type { SpawnToolDeps } from './tools/spawn.js';
export { TASKS_SYNC_SPAWN_DIR } from './constants.js';
export {
  SPAWN_TEMPLATES,
  DEFAULT_SPAWN_TEMPLATE,
  resolveSpawnTemplate,
} from './templates.js';
export type { SpawnTemplateName } from './templates.js';
