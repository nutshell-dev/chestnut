/**
 * @module L6.Watchdog.WorkspaceConfig
 * @layer L6 进程边界（Watchdog 守护进程）
 *
 * Phase 1289 Step B: Watchdog 自家 config store — `.chestnut/watchdog/config.yaml`
 * 的唯一 IO owner（监控参数语义 SoT 自 root YAML 迁回 Watchdog）。
 *
 * API 分三类：
 * - 读：loadWorkspaceWatchdogConfig（typed discriminated result：ok / missing /
 *   invalid，绝不静默创建）；readWorkspaceWatchdogConfig（消费方便捷读取，
 *   missing → throw fail-loud（Watchdog 协议：普通启动 missing fail-loud，
 *   仅 fresh init 创建默认），invalid → throw）。
 * - 写（fresh init）：initWorkspaceWatchdogConfig 创建默认配置 + 回读校验；
 *   已存在不覆盖。
 * - layout 留痕：publishWatchdogLayout 发布 layout.json（phase 1890 Step J 自
 *   config-migration-journal 收编；fresh init 直调）。
 *
 * fs 一律以 chestnutRoot 为 baseDir；路径全部出自 ./layout.js。
 */
import * as yaml from 'js-yaml';
import type { FileSystem } from '../foundation/fs/index.js';
import { formatErr } from '../foundation/node-utils/index.js';
import { WATCHDOG_LAYOUT_SCHEMA_VERSION, WATCHDOG_PATHS } from './layout.js';
import {
  watchdogWorkspaceConfigFileSchema,
  createDefaultWatchdogWorkspaceConfig,
  type WatchdogConfig,
} from './config-schema.js';

type WorkspaceWatchdogConfigResult =
  | { kind: 'ok'; config: WatchdogConfig }
  | { kind: 'missing' }
  | { kind: 'invalid'; message: string };

export function sameWatchdogConfig(a: WatchdogConfig, b: WatchdogConfig): boolean {
  return (
    a.interval_ms === b.interval_ms &&
    a.heartbeat_stale_timeout_ms === b.heartbeat_stale_timeout_ms
  );
}

/** 序列化为拍板磁盘形态（schema_version 在前、key 顺序固定）。 */
function serializeWorkspaceWatchdogConfig(config: WatchdogConfig): string {
  return yaml.dump({
    schema_version: WATCHDOG_LAYOUT_SCHEMA_VERSION,
    interval_ms: config.interval_ms,
    heartbeat_stale_timeout_ms: config.heartbeat_stale_timeout_ms,
  });
}

/**
 * 读取 workspace watchdog config。不创建、不改写任何文件。
 * invalid 覆盖：读失败 / YAML 语法错 / schema 校验失败。
 */
export function loadWorkspaceWatchdogConfig(fs: FileSystem): WorkspaceWatchdogConfigResult {
  if (!fs.existsSync(WATCHDOG_PATHS.config)) {
    return { kind: 'missing' };
  }
  let raw: string;
  try {
    raw = fs.readSync(WATCHDOG_PATHS.config);
  } catch (err) {
    return { kind: 'invalid', message: `read failed: ${formatErr(err)}` };
  }
  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    return { kind: 'invalid', message: `invalid YAML: ${formatErr(err)}` };
  }
  const result = watchdogWorkspaceConfigFileSchema.safeParse(parsed);
  if (!result.success) {
    return { kind: 'invalid', message: `schema validation failed: ${formatErr(result.error)}` };
  }
  return {
    kind: 'ok',
    config: {
      interval_ms: result.data.interval_ms,
      heartbeat_stale_timeout_ms: result.data.heartbeat_stale_timeout_ms,
    },
  };
}

/**
 * 消费方便捷读取。
 * ok → 配置值；missing → throw fail-loud（普通启动不允许静默创建默认，
 * 仅 fresh init 走 initWorkspaceWatchdogConfig）；invalid → throw。
 */
export function readWorkspaceWatchdogConfig(fs: FileSystem): WatchdogConfig {
  const result = loadWorkspaceWatchdogConfig(fs);
  if (result.kind === 'missing') {
    throw new Error(
      `Workspace watchdog config is missing (${WATCHDOG_PATHS.config}): ` +
      `run \`chestnut init\` to create defaults`,
    );
  }
  if (result.kind === 'invalid') {
    throw new Error(`Invalid workspace watchdog config (${WATCHDOG_PATHS.config}): ${result.message}`);
  }
  return result.config;
}

/** 写文件 + 回读校验（publish/create 共用）。 */
function writeAndVerify(fs: FileSystem, config: WatchdogConfig, context: string): void {
  fs.writeAtomicSync(WATCHDOG_PATHS.config, serializeWorkspaceWatchdogConfig(config));
  const readback = loadWorkspaceWatchdogConfig(fs);
  if (readback.kind !== 'ok' || !sameWatchdogConfig(readback.config, config)) {
    throw new Error(
      `Watchdog config ${context} readback verification failed (${WATCHDOG_PATHS.config}): ` +
      (readback.kind === 'ok'
        ? `expected ${JSON.stringify(config)}, got ${JSON.stringify(readback.config)}`
        : `${readback.kind}${readback.kind === 'invalid' ? `: ${readback.message}` : ''}`),
    );
  }
}

/**
 * Fresh init 专用：创建默认配置。已存在合法配置 → 'already'（不覆盖）；
 * 已存在但 invalid → throw（不静默抹掉用户/损坏文件）。
 */
export function initWorkspaceWatchdogConfig(fs: FileSystem): 'created' | 'already' {
  const existing = loadWorkspaceWatchdogConfig(fs);
  if (existing.kind === 'ok') return 'already';
  if (existing.kind === 'invalid') {
    throw new Error(
      `Cannot init workspace watchdog config: existing ${WATCHDOG_PATHS.config} is invalid: ${existing.message}`,
    );
  }
  writeAndVerify(fs, createDefaultWatchdogWorkspaceConfig(), 'init');
  return 'created';
}

/**
 * 发布 layout.json（phase 1890 Step J 自 config-migration-journal 收编，1:1）。
 * 内容是布局协议版本 + owner 声明 + 资源迁移账本（Phase 1455 Step C ratchet：
 * config Phase 1289 Step B / state Phase 1455 Step A / log Phase 1455 Step B 已迁，
 * subscriptions 0 生产使用退役）；路径 identity 的 SoT 是 ./layout.ts 常量，
 * 本函数只做磁盘留痕、不被生产代码读回。
 */
export function publishWatchdogLayout(fs: FileSystem): void {
  const layout = {
    schema_version: WATCHDOG_LAYOUT_SCHEMA_VERSION,
    owner: 'watchdog',
    updated_at: new Date().toISOString(),
    resources: {
      config: 'migrated',
      state: 'migrated',
      log: 'migrated',
      subscriptions: 'retired',
    },
  } as const;
  fs.writeAtomicSync(WATCHDOG_PATHS.layout, `${JSON.stringify(layout, null, 2)}\n`);
}
