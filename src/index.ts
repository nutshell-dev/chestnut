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

export type { Logger, LogEvent } from './foundation/monitor/types.js';
export { JsonlLogger } from './foundation/monitor/index.js';

export type { ILLMService } from './foundation/llm/index.js';
export { LLMService } from './foundation/llm/service.js';
export type { LLMServiceConfig, ProviderConfig, LLMCallOptions } from './foundation/llm/types.js';

// Re-export commonly used types
export type { ToolResult, ExecContext, ITool, IToolRegistry, IToolExecutor } from './core/tools/executor.js';
export type { SkillMeta } from './core/skill/registry.js';
export type { SubAgentTask } from './core/task/system.js';
export type { ProgressData, AcceptanceResult } from './core/contract/manager.js';

// Version
export const VERSION = '0.1.0';
