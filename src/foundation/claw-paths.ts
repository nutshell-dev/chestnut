/**
 * @module L2.ClawPaths
 *
 * chestnut claw 目录命名约定 (path const) + enumeration helper.
 *
 * phase 238 M#5/M#9 真治: phase 75 era 迁 → L6 Assembly own、但 27+ L4/L5 → L6
 * 反向 imports 累积 = M#5 strict violation。user 「要根治」 ratify Path #6 触发
 * 「原则冲突立即中断」、reverse phase 75 era trade-off、path const + helper 归
 * foundation 真 owner (path 是基础设施、与 fs/identity 同层、与 ClawId brand 同 owner、
 * L6 Assembly 仅 inject 不 own)。
 *
 * 注：phase 157 ratify「SNAPSHOT_IGNORE_PATTERNS 归 snapshot module own」已被 phase 693 revert。
 * SNAPSHOT_IGNORE_PATTERNS 现归 Assembly 装配组装（per architecture §29）、各 owner module 自家
 * 声明 *_SNAPSHOT_IGNORE。phase 157 原论证「M#1 patterns 是 snapshot 业务概念」错位——
 * patterns 内容是各 owner ephemeral 资源声明、Snapshot 持有 = 预设上层语义违反 M#5。
 */

import type { FileSystem } from './fs/index.js';

export const CLAWS_DIR = 'claws' as const;
export const CLAWSPACE_DIR = 'clawspace' as const;
/**
 * Claw spec file (per-claw business identity + role spec).
 * 由 daemon-entry pre-assemble 读、core/dialog 注入 context、cli init/start 模板写入。
 * phase 391: 抽 7 site inline 'AGENTS.md' literal 为 const (M#1 + ML#9)。
 */
export const CLAW_SPEC_FILE = 'AGENTS.md' as const;
/**
 * Claw memory file (per-claw persistent memory, dialog 注入 + status aggregator 读).
 * phase 392: 抽 4 site inline 'MEMORY.md' literal 为 const (M#1 + ML#9)。
 */
export const CLAW_MEMORY_FILE = 'MEMORY.md' as const;
/**
 * Claw identity file (per-claw identity section、Runtime initialize 读 + permissions 白名单).
 * phase 392: 抽 2 site inline 'IDENTITY.md' literal 为 const (M#1 + ML#9)。
 */
export const CLAW_IDENTITY_FILE = 'IDENTITY.md' as const;
/**
 * 其他 claw template / 运行时 file (phase 393 抽).
 * - SOUL.md: claw soul section（runtime init + cli motion template）
 * - USER.md: claw user section（runtime init + permissions whitelist）
 * - AUTH_POLICY.md: claw auth policy section（runtime init + cli motion template）
 * - HEARTBEAT.md: claw heartbeat checklist（heartbeat module + cli motion template）
 */
export const CLAW_SOUL_FILE = 'SOUL.md' as const;
export const CLAW_USER_FILE = 'USER.md' as const;
export const CLAW_AUTH_POLICY_FILE = 'AUTH_POLICY.md' as const;
export const CLAW_HEARTBEAT_FILE = 'HEARTBEAT.md' as const;

/**
 * Enumerate all claw IDs (sub-directories) under clawsDir.
 *
 * Filter: 默 `.filter(e => e.isDirectory)` (DP「不丢弃静默」+ safer corrupt FS case).
 *
 * Phase 234 (NEW location src/assembly/) → phase 238 (迁 src/foundation/). */
export function enumerateClaws(fs: FileSystem, clawsDir: string): string[] {
  return fs
    .listSync(clawsDir, { includeDirs: true })
    .filter(e => e.isDirectory)
    .map(e => e.name);
}
