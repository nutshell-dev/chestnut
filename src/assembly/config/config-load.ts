/**
 * Assembly config load module
 * phase 298: V12 (b) real-治、wrapper 反向迁 foundation → assembly
 *
 * Owns: root config wrapper (load/save/exists/patch) + LLM merge
 * Generic yaml CRUD delegates to L2a ConfigStore barrel (phase 1297 Step A; loader moved out of assembly)
 * Failure mapping: ConfigStore typed code → global/claw 业务文案 (phase 1297 Step B)
 * path primitive: getGlobalConfigPath in ./global-config-path.ts (phase 704)
 */
import * as path from 'path';
import {
  createGlobalConfigSchema,
  getClawConfigSchema,
  type ClawGlobalConfig,
  type ClawGlobalConfigInput,
  type ClawConfig,
} from './compose-config.js';
import {
  loadYamlConfig,
  writeYamlConfig,
  writeYamlConfigExclusive,
  patchYamlConfig,
  withYamlConfigLock,
  configExists,
  isConfigStoreError,
  type ConfigStoreError,
} from '../../foundation/config-store/index.js';
import { getGlobalConfigPath } from './global-config-path.js';
import { toProviderConfig } from '../../foundation/llm-orchestrator/index.js';
import type { LLMOrchestratorConfig } from '../../foundation/llm-orchestrator/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';

/**
 * ConfigStore typed failure → Assembly 业务文案（phase 1297 Step B）。
 * exhaustive switch：新增 ConfigStoreErrorCode 时 default 分支 never 赋值触发编译错误。
 * 对外 message 与 cause 链保持 phase 1297 前兼容：
 * - global missing 固定为 `Global config not found.`；
 * - read/YAML 失败原文重抛（包一层带 cause）；
 * - env/schema 仅替换 global/claw 前缀。
 */
function mapConfigStoreError(err: ConfigStoreError, kind: 'global' | 'claw'): Error {
  switch (err.code) {
    case 'not_found':
      // claw 路径先经 configExists 检查；竞态下原样传播 generic 文案（同旧行为）。
      return kind === 'global'
        ? new Error('Global config not found.', { cause: err })
        : err;
    case 'read_failed':
    case 'invalid_yaml':
      return new Error(err.message, { cause: err });
    case 'missing_env':
      return new Error(
        err.message.replace('Invalid config (env var):', `Invalid ${kind} config (env var):`),
        { cause: err },
      );
    case 'invalid_schema':
      return new Error(
        err.message.replace('Invalid config:', `Invalid ${kind} config:`),
        { cause: err },
      );
    case 'expected_object':
      // load 路径不产生（仅 patch root-shape）；原样传播。
      return err;
    case 'already_exists':
      // 由 saveGlobalConfigExclusive 自行映射为 GlobalConfigAlreadyExistsError；
      // 其余路径不产生该 code，原样传播。
      return err;
    case 'lock_timeout':
      return new Error(
        'Global config is busy: another process is updating it (lock timeout). Retry the command.',
        { cause: err },
      );
    default: {
      const exhaustive: never = err.code;
      throw new Error(`Unhandled ConfigStoreError code: ${String(exhaustive)}`);
    }
  }
}

export function loadGlobalConfig(deps: { fsFactory: (baseDir: string) => FileSystem }): ClawGlobalConfig {
  const configPath = getGlobalConfigPath();
  const schema = createGlobalConfigSchema();
  try {
    return loadYamlConfig<ClawGlobalConfig>(
      { fsFactory: deps.fsFactory },
      configPath,
      schema,
    );
  } catch (err) {
    if (isConfigStoreError(err)) {
      throw mapConfigStoreError(err, 'global');
    }
    throw err;
  }
}

export function isInitialized(deps: { fsFactory: (baseDir: string) => FileSystem }): boolean {
  const configPath = getGlobalConfigPath();
  const dir = path.dirname(configPath);
  const fs = deps.fsFactory(dir);
  return fs.existsSync(path.basename(configPath));
}

export function saveGlobalConfig(deps: { fsFactory: (baseDir: string) => FileSystem }, config: ClawGlobalConfigInput): void {
  const configPath = getGlobalConfigPath();
  writeYamlConfig(
    { fsFactory: deps.fsFactory },
    configPath,
    config,
  );
}

/**
 * Phase 1910 Step D（RACE-CONFIG-INIT-LOST-UPDATE）：workspace 初始化的唯一
 * 提交点。目标已存在（并发 init winner）→ GlobalConfigAlreadyExistsError，
 * loser 重读已提交配置、不覆盖。
 */
export class GlobalConfigAlreadyExistsError extends Error {
  constructor(readonly configPath: string) {
    super(`Global config already initialized: ${configPath}`);
    this.name = 'GlobalConfigAlreadyExistsError';
  }
}

export function saveGlobalConfigExclusive(deps: { fsFactory: (baseDir: string) => FileSystem }, config: ClawGlobalConfigInput): void {
  const configPath = getGlobalConfigPath();
  try {
    writeYamlConfigExclusive(
      { fsFactory: deps.fsFactory },
      configPath,
      config,
    );
  } catch (err) {
    if (isConfigStoreError(err) && err.code === 'already_exists') {
      throw new GlobalConfigAlreadyExistsError(configPath);
    }
    throw err;
  }
}

/**
 * Phase 1910 Step D（RACE-CONFIG-READ-MODIFY-WRITE）：global config 的
 * 串行化 read→modify→write。锁内重新读盘（不用调用方旧快照），mutator 抛出
 * 的业务错误原样传播且不提交。与 loadGlobal+saveGlobal 逐语义等价，仅增加
 * 跨进程序列化。
 */
export async function mutateGlobalConfigLocked(
  deps: { fsFactory: (baseDir: string) => FileSystem },
  mutator: (config: ClawGlobalConfig) => void,
): Promise<void> {
  const configPath = getGlobalConfigPath();
  try {
    await withYamlConfigLock({ fsFactory: deps.fsFactory }, configPath, () => {
      const fresh = loadYamlConfig<ClawGlobalConfig>(
        { fsFactory: deps.fsFactory },
        configPath,
        createGlobalConfigSchema(),
      );
      mutator(fresh);
      writeYamlConfig({ fsFactory: deps.fsFactory }, configPath, fresh);
    });
  } catch (err) {
    if (isConfigStoreError(err)) {
      throw mapConfigStoreError(err, 'global');
    }
    throw err;
  }
}

export function loadClawConfig(deps: { fsFactory: (baseDir: string) => FileSystem }, configPath: string): ClawConfig | undefined {
  if (!configExists({ fsFactory: deps.fsFactory }, configPath)) {
    return undefined;
  }
  try {
    return loadYamlConfig<ClawConfig>(
      { fsFactory: deps.fsFactory },
      configPath,
      getClawConfigSchema(),
    );
  } catch (err) {
    if (isConfigStoreError(err)) {
      throw mapConfigStoreError(err, 'claw');
    }
    throw err;
  }
}

export async function patchGlobalConfigPrimary(deps: { fsFactory: (baseDir: string) => FileSystem }, patch: Record<string, unknown>): Promise<void> {
  const configPath = getGlobalConfigPath();
  try {
    // Phase 1910 Step D：raw patch 同样走 per-path 锁，与全量 mutation 互斥。
    await withYamlConfigLock({ fsFactory: deps.fsFactory }, configPath, () => {
      patchYamlConfig(
        { fsFactory: deps.fsFactory },
        configPath,
        (cfg) => {
          const llm = cfg.llm as Record<string, unknown> | undefined;
          if (!llm || typeof llm !== 'object') {
            throw new Error('Invalid global config: missing llm section');
          }
          const primary = llm.primary as Record<string, unknown> | undefined;
          if (!primary || typeof primary !== 'object') {
            throw new Error('Invalid global config: missing llm.primary section');
          }
          for (const [k, v] of Object.entries(patch)) {
            primary[k] = v;
          }
        },
      );
    });
  } catch (err) {
    if (isConfigStoreError(err)) {
      throw mapConfigStoreError(err, 'global');
    }
    throw err;
  }
}

export function saveClawConfig(deps: { fsFactory: (baseDir: string) => FileSystem }, configPath: string, config: ClawConfig): void {
  writeYamlConfig(
    { fsFactory: deps.fsFactory },
    configPath,
    config,
  );
}

/**
 * Phase 1910 Step E（RACE-CLAW-CREATE-CHECK-THEN-CREATE）：claw 创建的独占
 * 发布提交点。claw config 是 claw 资源的身份 artifact（loadClaw 读它），
 * O_EXCL 独占创建即创建权裁决；已存在 → ClawConfigAlreadyExistsError，
 * loser 不得覆盖。
 */
export class ClawConfigAlreadyExistsError extends Error {
  constructor(readonly configPath: string) {
    super(`Claw config already exists: ${configPath}`);
    this.name = 'ClawConfigAlreadyExistsError';
  }
}

export function saveClawConfigExclusive(deps: { fsFactory: (baseDir: string) => FileSystem }, configPath: string, config: ClawConfig): void {
  try {
    writeYamlConfigExclusive(
      { fsFactory: deps.fsFactory },
      configPath,
      config,
    );
  } catch (err) {
    if (isConfigStoreError(err) && err.code === 'already_exists') {
      throw new ClawConfigAlreadyExistsError(configPath);
    }
    throw err;
  }
}

export function clawExists(deps: { fsFactory: (baseDir: string) => FileSystem }, configPath: string): boolean {
  const dir = path.dirname(configPath);
  const fs = deps.fsFactory(dir);
  return fs.existsSync(path.basename(configPath));
}



// Build LLMOrchestratorConfig from global + claw config
// phase 1300 Step A: resolveLLMConfig 为 owner 名称（phase 1886 Step B: 兼容
// alias buildLLMConfig 已删除，src/tests 旧名零命中）。
export function resolveLLMConfig(
  globalConfig: ClawGlobalConfig,
  clawConfig?: ClawConfig
): LLMOrchestratorConfig {
  // Use claw's primary if provided, otherwise use global's primary
  const primaryProvider = clawConfig?.llm?.primary
    ? toProviderConfig(clawConfig.llm.primary)
    : toProviderConfig(globalConfig.llm.primary);

  const fallbackList = globalConfig.llm.fallbacks ?? [];

  // Circuit breaker config
  const cb = globalConfig.llm.circuit_breaker;

  return {
    primary: primaryProvider,
    fallbacks: fallbackList.map(toProviderConfig),
    maxAttempts: globalConfig.llm.retry_attempts,
    retryDelayMs: globalConfig.llm.retry_delay_ms,
    events: { emit: () => {} },
    circuitBreaker: cb ? {
      failureThreshold: cb.failure_threshold,
      resetTimeoutMs: cb.reset_timeout_ms,
    } : undefined,
  };
}
