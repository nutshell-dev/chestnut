/**
 * @module L6.CLI.Claw.Deps
 *
 * Phase 1324 Step A：Claw 命令族共享 required 窄 deps（CLIProcess 内部稳定协议）。
 *
 * - Router 与逐步迁移的 leaf handler 共享同一份 deps 形状（M#7），leaf 不再
 *   各自 deep-import Assembly config internal 离散函数（M#5/M#8）；
 * - `rootConfig` 为 required `Pick<RootConfigReader, 'loadGlobal' | 'loadClaw'>`
 *   （M#9）：不可消除的配置耦合显式交给编译器检查，不接 Admin 宽面、不 optional、
 *   不自构造 fallback；
 * - type-only 依赖 Assembly 稳定 barrel，不进入 CLIProtocol，Assembly 不了解
 *   具体命令族。
 */

import type { RootConfigAdmin, RootConfigReader } from '../../assembly/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';

export interface ClawCommandDeps {
  fsFactory(baseDir: string): FileSystem;
  // phase 1301 Step B 起：required 窄 DI（M#8/M#9）。漏注入在 tsc 编译期失败。
  rootConfig: Pick<RootConfigReader, 'loadGlobal' | 'loadClaw'>;
}

/** Create独享的最小写面；普通Claw leaf仍只接收上方Reader。 */
export interface ClawCreateCommandDeps {
  fsFactory: ClawCommandDeps['fsFactory'];
  rootConfig: ClawCommandDeps['rootConfig'] & Pick<RootConfigAdmin, 'saveClaw'>;
}
