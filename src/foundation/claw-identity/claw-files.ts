/**
 * @module L2c.ClawIdentity
 *
 * Claw 目录内文件/子目录命名约定。
 * 单个 claw 的身份相关常量；复数 claws 容器（CLAWS_DIR）与枚举归 L4.ClawTopology。
 * phase 705 自 foundation/claw-paths.ts 迁入。
 */

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
