/**
 * Assembly RootConfig capability
 * phase 1300 Step A: 建立稳定 RootConfig Reader/Admin capability。
 *
 * 只组合同模块 config-load.ts 既有 owner 函数，不重复 IO/schema 逻辑；
 * factory 闭包持有且只持有 deps（FileSystem factory），不缓存任何配置结果，
 * 每次 load 仍从磁盘重建（M#4 capability 不成为内存权威）。
 * 方法为闭包箭头函数，不依赖 `this`，可被窄 DI 解构后直接调用（M#9）。
 *
 * （phase 1890 Step L：RootConfigLegacyMigration 兼容期迁移面随存量废弃删除。）
 */
import {
  isInitialized,
  loadGlobalConfig,
  loadClawConfig,
  saveGlobalConfig,
  saveGlobalConfigExclusive,
  mutateGlobalConfigLocked,
  saveClawConfig,
  saveClawConfigExclusive,
  patchGlobalConfigPrimary,
} from './config-load.js';
import type {
  ClawGlobalConfig,
  ClawGlobalConfigInput,
  ClawConfig,
} from './compose-config.js';
import type { FileSystem } from '../../foundation/fs/index.js';

/** RootConfig 只读面：日常 init/start 分支判断与读盘。 */
export interface RootConfigReader {
  /** global config 是否已初始化（`.chestnut/config.yaml` 存在）。 */
  isInitialized(): boolean;
  /** 读取 global config；missing 时 fail-loud（`Global config not found.`）。 */
  loadGlobal(): ClawGlobalConfig;
  /** 读取指定路径的 claw config；文件不存在返回 undefined。 */
  loadClaw(configPath: string): ClawConfig | undefined;
}

/** RootConfig 管理面：在 Reader 之上增加写与 primary patch。 */
export interface RootConfigAdmin extends RootConfigReader {
  saveGlobal(config: ClawGlobalConfigInput): void;
  /**
   * Phase 1910 Step D：初始化唯一提交点（O_EXCL）；已初始化时 throw
   * GlobalConfigAlreadyExistsError，loser 重读已提交配置、不覆盖。
   */
  saveGlobalExclusive(config: ClawGlobalConfigInput): void;
  /**
   * Phase 1910 Step D：global config 串行化 read→modify→write（跨进程锁内
   * 重读新鲜配置）；mutator 抛错原样传播且不提交。
   */
  mutateGlobalLocked(mutator: (config: ClawGlobalConfig) => void): Promise<void>;
  saveClaw(configPath: string, config: ClawConfig): void;
  /**
   * Phase 1910 Step E：claw 创建独占发布提交（O_EXCL）；config 已存在时 throw
   * ClawConfigAlreadyExistsError，loser 不得覆盖。
   */
  saveClawExclusive(configPath: string, config: ClawConfig): void;
  /** patch global config 的 llm.primary 段（锁内 raw patch）；输入 readonly，边界内复制，caller 对象不被修改。 */
  patchPrimary(patch: Readonly<Record<string, unknown>>): Promise<void>;
}

export interface RootConfigDeps {
  fsFactory(baseDir: string): FileSystem;
}

/**
 * 建立 RootConfig capability。闭包只持有 deps，每次调用仍从磁盘读取；
 * 不缓存配置、不保存配置结果。
 */
export function createRootConfig(deps: RootConfigDeps): RootConfigAdmin {
  return {
    isInitialized: () => isInitialized(deps),
    loadGlobal: () => loadGlobalConfig(deps),
    loadClaw: (configPath) => loadClawConfig(deps, configPath),
    saveGlobal: (config) => saveGlobalConfig(deps, config),
    saveGlobalExclusive: (config) => saveGlobalConfigExclusive(deps, config),
    mutateGlobalLocked: (mutator) => mutateGlobalConfigLocked(deps, mutator),
    saveClaw: (configPath, config) => saveClawConfig(deps, configPath, config),
    saveClawExclusive: (configPath, config) => saveClawConfigExclusive(deps, configPath, config),
    patchPrimary: (patch) => patchGlobalConfigPrimary(deps, { ...patch }),
  };
}
