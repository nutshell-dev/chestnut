/**
 * @module L2b.DialogStore
 * DialogStore module (L2)
 *
 * Messages array persistence. Serves crash-recoverable sessions.
 * Dependency: FileSystem
 */

export { DialogStore } from './store.js';
// phase 1800: canonical dialog message（业务元数据 owner，自 llm-provider 迁入）
export type { Message } from './canonical-message.js';
// phase 483: audit-events barrel re-export
export { DIALOG_AUDIT_EVENTS } from './audit-events.js';
// phase 1850 Step F: 单一公开校验入口 + 结果协议类型
export { parseSessionData } from './validate.js';
export type { SessionParseOutcome } from './validate.js';
export type {
  SessionData,
  LoadResult,
  StableLoadResult,
  DialogSaveSnapshot,
  DialogSaveResult,
  DialogSessionLifecycle,
  BlockIdAssignment,
} from './types.js';
// phase 1850 Step C: save clone 分配的 blockId 显式回传写回原语
export { applyBlockIdAssignments } from './apply-block-ids.js';
export { repairMessages as repairDialogMessages } from './repair.js';
// phase 1406: regime switch 业务（dialog 资源重组）从 Runtime 迁入 DialogStore module
export { performRegimeSwitch } from './regime-switch.js';

// phase 1432 F6: dirs path const re-export — 跨模块 (cli) 路径合成走 barrel。
// allowlist: assembly/assemble.ts (装配根 bootstrap by-design)。
export { DIALOG_DIR, DIALOG_ARCHIVE_DIR, DIALOG_ARCHIVE_SUBDIR, CURRENT_DIALOG_FILE } from './dirs.js';

// phase 751-752: lightweight archive listing
export { listArchiveDialogFiles } from './list-archive.js';

// phase 147 Step B: lookup helper + 4 级降级路径
export {
  lookupContentByToolUseId,
  lookupContentByBlockId,
} from './lookup.js';
export type {
  LookupResult,
  LookupOptions,
  BlockIdLookupResult,
} from './lookup.js';

// Phase 1186: blockId short ↔ full UUID index
export { BlockIdIndex } from './block-id-index.js';

// Phase 992: barrel export error classes + core types to stop cross-module deep imports.
export { DialogIOError } from './errors.js';

export { createDialogStore } from './store.js';

