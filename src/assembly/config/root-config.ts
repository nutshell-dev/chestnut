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
  saveGlobalConfigExclusive,
  migrateRootLLMConfigLocked,
  saveClawConfig,
  saveClawConfigExclusive,
  getInitializationState,
  completeInitialization,
} from './config-load.js';
import type { InitializationState } from './config-load.js';
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

/** RootConfig 管理面：root 非 LLM 字段与初始化协调；LLM 管理入口归 L4。 */
export interface RootConfigAdmin extends RootConfigReader {
  /**
   * Phase 1910 Step D：初始化唯一提交点（O_EXCL）；已初始化时 throw
   * GlobalConfigAlreadyExistsError，loser 重读已提交配置、不覆盖。
   */
  saveGlobalExclusive(config: ClawGlobalConfigInput): void;
  /** root 锁内执行 legacy LLM 迁移；目标未确认 durable 时保留源。 */
  migrateLLMConfiguration(): Promise<void>;
  saveClaw(configPath: string, config: ClawConfig): void;
  /**
   * Phase 1910 Step E：claw 创建独占发布提交（O_EXCL）；config 已存在时 throw
   * ClawConfigAlreadyExistsError，loser 不得覆盖。
   */
  saveClawExclusive(configPath: string, config: ClawConfig): void;
  /**
   * Phase 1911 Step D：typed 初始化状态（诊断读）。'initialized' 的对外可见
   * 依据是 ready marker + 必需布局核验，不是 root YAML exists。
   */
  getInitializationState(): InitializationState;
  /**
   * Phase 1911 Step D：幂等完成 bootstrap（audit/watchdog config、layout、logs
   * 归各 owner 幂等物化），核验后发布 ready marker。崩溃窗口/legacy 无 marker
   * 布局均经此恢复；owner 遇 invalid 配置 throw fail-loud，不覆盖。
   */
  completeInitialization(): void;
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
    saveGlobalExclusive: (config) => saveGlobalConfigExclusive(deps, config),
    migrateLLMConfiguration: () => migrateRootLLMConfigLocked(deps),
    saveClaw: (configPath, config) => saveClawConfig(deps, configPath, config),
    saveClawExclusive: (configPath, config) => saveClawConfigExclusive(deps, configPath, config),
    getInitializationState: () => getInitializationState(deps),
    completeInitialization: () => completeInitialization(deps),
  };
}
