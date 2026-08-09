/**
 * @module L4.MemorySystem
 * MemorySystem module (L4)
 *
 * 智能体记忆整合——dream、经验提炼、知识沉淀。
 * motion 独占装配（Philosophy "motion 主动整合多个智能体的持久化记忆充分提取信息"）。
 */

export { MEMORY_DIR } from './memory-paths.js';
export { MemorySystem } from './system.js';
export { createMemorySystem } from './system.js';
export { memorySearchTool } from './tools/memory_search.js';
export { MEMORY_FILE_ROUTING } from './audit-events.js';
export { MEMORY_INBOX_MESSAGE_TYPES } from './inbox-formatter.js';
export { createDreamTriggerJob } from './jobs/dream-trigger.js';
export { createClawContractBridge } from './claw-contract-bridge.js';
