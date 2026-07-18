// src/core/contract/dirs.ts
/**
 * Contract 模块资源命名空间 const
 * phase 746 物理迁自 types/paths.ts、M#3 资源唯一归属合规
 * phase 1107: canonical owner (no longer re-export from foundation/paths, M#5)
 * phase 389: 加 3 file name const (PROGRESS_FILE / CONTRACT_YAML_FILE / PROGRESS_LOCK_FILE) — M#1 + ML#9
 */
export const CONTRACT_DIR = 'contract' as const;
export const CONTRACT_ACTIVE_DIR = 'contract/active' as const;
export const CONTRACT_PAUSED_DIR = 'contract/paused' as const;
export const CONTRACT_ARCHIVE_DIR = 'contract/archive' as const;
export const CONTRACT_ARCHIVE_COMPLETED_DIR = 'contract/archive/completed' as const;
export const CONTRACT_ARCHIVE_CANCELLED_DIR = 'contract/archive/cancelled' as const;
export const CONTRACT_ARCHIVE_CORRUPTED_DIR = 'contract/archive/corrupted' as const;
export const PROGRESS_FILE = 'progress.json' as const;
export const CONTRACT_YAML_FILE = 'contract.yaml' as const;
export const PROGRESS_LOCK_FILE = 'progress.lock' as const;
