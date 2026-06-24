/**
 * Configuration barrel re-export.
 *
 * Sub-files:
 * - loader.ts (generic yaml CRUD, L2a)
 *
 * Workspace path primitives live in core/claw-topology/claw-instance-paths.ts.
 *
 * Phase 704 migration:
 * - getGlobalConfigPath → assembly/global-config-path.ts (canonical owner: L6 Assembly)
 * - getClawDir / getClawConfigPath / makeChestnutRoot / resolveChestnutRoot
 *   → core/claw-topology/claw-instance-paths.ts (canonical owner: L4 ClawTopology)
 *
 * ⚠️ Backward-compat re-exports below keep existing test mocks working.
 *   Remove when all consumers import from canonical paths directly.
 */

// ── Workspace path primitives (L2a) ──────────────────────
export {
  getWorkspaceRoot,
  getChestnutRoot,
  getNamedSubrootDir,
} from '../../core/claw-topology/claw-instance-paths.js';

// ── Backward-compat（phase 704，后续 phase 清理）─────────
export { getGlobalConfigPath } from '../../assembly/global-config-path.js';
export {
  getClawDir,
  getClawConfigPath,
  makeChestnutRoot,
  resolveChestnutRoot,
} from '../../core/claw-topology/claw-instance-paths.js';

// ── Generic YAML config loader (L2a) ─────────────────────
export {
  loadYamlConfig,
  writeYamlConfig,
  patchYamlConfig,
  configExists,
} from './loader.js';
export type { LoaderDeps } from './loader.js';

// ── LLM Provider presets ─────────────────────────────────
export { PRESETS } from '../llm-provider/presets.js';
