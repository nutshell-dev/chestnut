// src/core/contract/dirs.ts
/**
 * Contract 模块资源命名空间 const
 * phase 746 物理迁自 types/paths.ts、M#3 资源唯一归属合规
 * phase 1107: canonical owner (no longer re-export from foundation/paths, M#5)
 */
export const CONTRACT_DIR = 'contract' as const;
export const CONTRACT_ACTIVE_DIR = 'contract/active' as const;
export const CONTRACT_PAUSED_DIR = 'contract/paused' as const;
export const CONTRACT_ARCHIVE_DIR = 'contract/archive' as const;
