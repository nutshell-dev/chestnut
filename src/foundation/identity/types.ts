/**
 * @module L2.Identity (foundation 层 cross-module ID 类型 own)
 * phase 1358：ClawId 跨 module 概念、归 foundation 层 own (per ML#3 资源唯一归属)
 */

declare const ClawIdBrand: unique symbol;
export type ClawId = string & { readonly [ClawIdBrand]: true };
export function makeClawId(s: string): ClawId { return s as ClawId; }

// NEW phase 1365 r-phase1365: TaskId 物理迁自 core/async-task-system/types.ts
// per ML#3 资源唯一归属 + phase 1358 ID branding ClawId 模板 mirror
declare const TaskIdBrand: unique symbol;
export type TaskId = string & { readonly [TaskIdBrand]: true };
export function makeTaskId(s: string): TaskId { return s as TaskId; }

// NEW phase 1378 r-phase1378: ContractId 物理迁自 core/contract/types.ts
// per ML#3 资源唯一归属 + phase 1358 ID branding ClawId/TaskId 模板 mirror
declare const ContractIdBrand: unique symbol;
export type ContractId = string & { readonly [ContractIdBrand]: true };
export function makeContractId(s: string): ContractId { return s as ContractId; }

// ============================================================================
// phase 1376: ClawDir + ClawforumRoot branded path types (compile-time path discrimination)
// per ML#3 资源唯一归属 + phase 1358 brand template mirror
// ============================================================================

declare const ClawDirBrand: unique symbol;
export type ClawDir = string & { readonly [ClawDirBrand]: true };
export function makeClawDir(s: string): ClawDir { return s as ClawDir; }

declare const ClawforumRootBrand: unique symbol;
export type ClawforumRoot = string & { readonly [ClawforumRootBrand]: true };
export function makeClawforumRoot(s: string): ClawforumRoot { return s as ClawforumRoot; }

// ============================================================================
// phase 1406: clawforumRoot 推算单一 truth source
// per design row A.phase1406-motion-config-not-module-and-wires：
//   消除 8+ site `path.join(*clawDir, '..')` / `path.join(*clawDir, '..', '..')`
//   散落（phase 1387/1388/1389 反复 fix 实证 Clawforum 模块缺失）。
// ============================================================================
import * as path from 'node:path';

/**
 * 从 clawDir 推算 clawforumRoot 的单一权威函数。
 *
 * 目录拓扑（design/architecture.md 系统拓扑节）：
 *   motion claw：`<root>/motion/`         → motion claw clawDir 的父 = root
 *   普通 claw： `<root>/claws/<id>/`     → 普通 claw clawDir 的祖父 = root
 *
 * 调用方需告知是否 motion（来自 Assembly 装配期 isMotion guard）。
 *
 * 本函数是 phase 1387/1388/1389 cluster 反复 fix 的实然终结点：
 * 所有 `path.join(*, '..')` 推算 clawforumRoot 必经此函数（lint enforce 推 Step Z）。
 *
 * @param clawDir 此 claw 的实例目录（branded ClawDir）
 * @param isMotion 是否 motion claw（拓扑差异由配置决定 / 非模块差异）
 * @returns branded ClawforumRoot
 */
export function resolveClawforumRoot(clawDir: ClawDir, isMotion: boolean): ClawforumRoot {
  return isMotion
    ? makeClawforumRoot(path.join(clawDir, '..'))  // Motion-only callsite: motion clawDir = <root>/motion → root
    : makeClawforumRoot(path.join(clawDir, '..', '..'));
}
