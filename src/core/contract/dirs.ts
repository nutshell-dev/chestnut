// src/core/contract/dirs.ts
/**
 * Contract 模块资源命名空间 const
 * phase 746 物理迁自 types/paths.ts、M#3 资源唯一归属合规
 * phase 1107: canonical owner (no longer re-export from foundation/paths, M#5)
 * phase 389: 加 2 file name const (PROGRESS_FILE / CONTRACT_YAML_FILE) — M#1 + ML#9
 */
export const CONTRACT_DIR = 'contract' as const;
export const CONTRACT_ACTIVE_DIR = 'contract/active' as const;
export const CONTRACT_PAUSED_DIR = 'contract/paused' as const;
export const CONTRACT_ARCHIVE_DIR = 'contract/archive' as const;
export const CONTRACT_ARCHIVE_CORRUPTED_DIR = 'contract/archive/corrupted' as const;
export const CONTRACT_LIFECYCLE_INTENTS_DIR = 'contract/lifecycle-intents' as const;
// Phase 1201 Step C: durable immutable verification outcome store (additive 资源、
// 位于 active/archive 之外、不随 terminal rename 删除、非 lifecycle SoT)。
export const CONTRACT_VERIFICATION_OUTCOMES_DIR = 'contract/verification-outcomes' as const;
export const PROGRESS_FILE = 'progress.json' as const;
export const CONTRACT_YAML_FILE = 'contract.yaml' as const;

// Phase 1193 Step B: current-format archive payload subtasks directory (read-only).
export const CONTRACT_SUBTASKS_DIR = 'subtasks' as const;
