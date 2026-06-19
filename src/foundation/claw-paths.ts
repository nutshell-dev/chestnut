/**
 * @module Foundation.ClawPaths
 *
 * chestnut claw 目录命名约定 (path const) + enumeration helper.
 *
 * phase 238 M#5/M#9 真治: phase 75 era 迁 → L6 Assembly own、但 27+ L4/L5 → L6
 * 反向 imports 累积 = M#5 strict violation。user 「要根治」 ratify Path #6 触发
 * 「原则冲突立即中断」、reverse phase 75 era trade-off、path const + helper 归
 * foundation 真 owner (path 是基础设施、与 fs/identity 同层、与 ClawId brand 同 owner、
 * L6 Assembly 仅 inject 不 own)。
 *
 * sister phase 157 SNAPSHOT_IGNORE_PATTERNS 归 snapshot module own (M#3 + Philosophy
 * 「系统能自己做的就自己做好」同型真治模板)。
 */

import type { FileSystem } from './fs/types.js';

export const CLAWS_DIR = 'claws' as const;
export const CLAWSPACE_DIR = 'clawspace' as const;
/**
 * Claw spec file (per-claw business identity + role spec).
 * 由 daemon-entry pre-assemble 读、core/dialog 注入 context、cli init/start 模板写入。
 * phase 391: 抽 7 site inline 'AGENTS.md' literal 为 const (M#1 + ML#9)。
 */
export const CLAW_SPEC_FILE = 'AGENTS.md' as const;

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
