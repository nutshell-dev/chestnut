/**
 * @module L4.SpawnSystem.Helpers
 * Module-level error format helper for spawn-system.
 *
 * phase 763：从 async-task-system/_helpers.ts 复制 formatErr 1 行 / 避免跨模块 deep import / Q3 决策。
 * phase 835：promote 至 src/types/utils.ts，改 thin re-export（caller 0 cascade）。
 */

export { formatErr } from '../../foundation/node-utils/format.js';
