/**
 * Clawforum - AI Agent Orchestration System
 * 
 * Main library exports
 */

// Types
export * from './types/index.js';

// Core runtime and modules
export * from './core/index.js';

// Foundation modules (selective exports)
export type { FileSystem, FileEntry, FileSystemOptions } from './foundation/fs/types.js';
export { NodeFileSystem } from './foundation/fs/node-fs.js';

export { Heartbeat, createHeartbeat } from './core/runtime/index.js';

export type { LLMService } from './foundation/llm/index.js';
export { LLMServiceImpl } from './foundation/llm/service.js';
export type { LLMServiceConfig, ProviderConfig, LLMCallOptions } from './foundation/llm/types.js';

// Re-export commonly used types
export type { ToolResult, ExecContext, Tool, ToolRegistry, IToolExecutor } from './core/tools/executor.js';
export { ToolRegistryImpl } from './core/tools/registry.js';
export type { SkillMeta } from './core/skill/registry.js';
export type { SubAgentTask } from './core/task/system.js';
export type { ProgressData, AcceptanceResult } from './core/contract/manager.js';

// Version
export const VERSION = '0.1.0';
