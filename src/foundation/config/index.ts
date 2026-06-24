/**
 * Configuration barrel re-export.
 *
 * Sub-files:
 * - loader.ts (generic yaml CRUD, L2a)
 *
 * Workspace path primitives live in core/claw-topology/claw-instance-paths.ts.
 * Global config path lives in assembly/global-config-path.ts.
 * LLM provider presets live in foundation/llm-provider/presets.ts.
 */

// ── Generic YAML config loader (L2a) ─────────────────────
export {
  loadYamlConfig,
  writeYamlConfig,
  patchYamlConfig,
  configExists,
} from './loader.js';
export type { LoaderDeps } from './loader.js';
