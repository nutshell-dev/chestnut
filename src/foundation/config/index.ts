/**
 * Configuration barrel re-export / phase 500 A.3 functional split
 *
 * 3 sub-file:
 * - schemas.ts (zod schemas + types)
 * - crud.ts (load/save/exists)
 * - adapters.ts (toProviderConfig + buildLLMConfig)
 *
 * Path getters (getWorkspaceRoot, getClawDir, ...) now live in foundation/paths.ts.
 */

// Schemas + types
export {
  FORMAT_MAP,
  createLLMProviderSchema,
  createCircuitBreakerSchema,
  createClawGlobalConfigSchema,
  createClawConfigSchema,
} from './schemas.js';
export type {
  ConfigDefaults,
  LLMProviderConfig,
  ClawGlobalConfig,
  ClawConfig,
} from './schemas.js';

// Path getters + shared constants (canonical owner: foundation/paths.ts)
export { CLAW_SUBDIRS } from '../paths.js';
export {
  getWorkspaceRoot,
  getGlobalConfigPath,
  getClawDir,
  getClawforumRoot,
  getNamedSubrootDir,
  getClawConfigPath,
} from '../paths.js';

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

// LLM Provider presets (re-export to avoid CLI bypassing L2 config, phase1101)
export { PRESETS } from '../llm-provider/presets.js';
