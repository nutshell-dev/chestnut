/**
 * @module L4.MemorySystem
 * MemorySystem module (L4)
 *
 * 智能体记忆整合——dream、经验提炼、知识沉淀。
 * motion 独占装配（Philosophy "motion 主动整合多个智能体的持久化记忆充分提取信息"）。
 */

export { MemorySystem } from './system.js';
export type { MemorySystemOptions } from './system.js';
export { createMemorySystem } from './system.js';
export { memorySearchTool, MEMORY_SEARCH_TOOL_NAME } from './tools/memory_search.js';

// Internal exports for direct consumers (if any)
export { runDeepDream, type DeepDreamOptions } from './deep-dream.js';
export { runRandomDream, type RandomDreamOptions } from './random-dream.js';
