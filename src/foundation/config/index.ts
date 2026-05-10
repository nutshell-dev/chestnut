/**
 * @module L1.Config (factually L2 cross-cutting per arch §6)
 *
 * Configuration barrel re-export / phase 500 A.3 functional split
 *
 * 4 sub-file:
 * - schemas.ts (zod schemas + types)
 * - paths.ts (path getters)
 * - crud.ts (load/save/exists)
 * - adapters.ts (toProviderConfig + buildLLMConfig)
 */

// Schemas + types
export {
  FORMAT_MAP,
  LLMProviderSchema,
  CircuitBreakerSchema,
  ClawGlobalConfigSchema,
  ClawConfigSchema,
} from './schemas.js';
export type { ClawGlobalConfig, ClawConfig } from './schemas.js';

// Path getters + re-export shared constants
export { CLAW_SUBDIRS } from './paths.js';
export {
  getWorkspaceRoot,
  getGlobalConfigPath,
  getClawDir,
  getMotionDir,
  getClawforumRoot,
  resolveAgentDir,
  getClawConfigPath,
} from './paths.js';

// CRUD
export {
  loadGlobalConfig,
  isInitialized,
  saveGlobalConfig,
  loadClawConfig,
  patchGlobalConfigPrimary,
  saveClawConfig,
  clawExists,
} from './crud.js';

// Adapters
export { toProviderConfig, buildLLMConfig } from './adapters.js';
