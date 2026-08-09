/**
 * Phase 1289 Step B: CLIProcess 迁移编排矩阵（ensureWatchdogConfigMigrated）。
 *
 * 矩阵：
 * - not-initialized（无 root config.yaml）→ 不动任何文件
 * - 仅 legacy → 全量迁移成功 + root YAML 其余字段语义不变 + intent/outcome/layout 齐备；
 *   legacy 段含 log_archive_days → 捕获进 intent retired_fields（显式退役、不进新 config）
 * - 仅新 → already（无 journal）
 * - 两边同值 → 删 legacy、outcome completed（published=false）
 * - 两边冲突 → fail-loud 抛错、双方保留、journal 留 conflict outcome；重跑同 id 持久 fail-loud
 * - 两边皆无 → missing、不静默创建
 * - 中断恢复：仅 intent（crash 于 publish 前）/ publish 后（crash 于删 legacy 前）/
 *   删 legacy 后（crash 于 outcome 前）→ 均可幂等续跑
 * - 迁移完成后重入 → already（幂等）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { ensureWatchdogConfigMigrated } from '../../src/cli/watchdog-config-migration.js';
import { WATCHDOG_LAYOUT_SCHEMA_VERSION, WATCHDOG_PATHS } from '../../src/watchdog/layout.js';
import type { WatchdogConfig } from '../../src/watchdog/config-schema.js';
import {
  loadWorkspaceWatchdogConfig,
  publishMigratedWorkspaceWatchdogConfig,
} from '../../src/watchdog/workspace-config.js';
import {
  writeWatchdogMigrationIntent,
  readWatchdogMigrationJournal,
  findPendingWatchdogMigration,
} from '../../src/watchdog/config-migration-journal.js';
import { createTrackedTempDirSync } from '../utils/temp.js';
import { createRootConfig, createRootConfigLegacyMigration } from '../../src/assembly/index.js';

const fsFactory = (baseDir: string) => new NodeFileSystem({ baseDir });
const deps = {
  fsFactory,
  rootConfig: createRootConfig({ fsFactory }),
  rootConfigLegacy: createRootConfigLegacyMigration({ fsFactory }),
};

const LEGACY_CUSTOM: WatchdogConfig = {
  interval_ms: 60000,
  disk_warning_mb: 1024,
  claw_inactivity_timeout_ms: 600000,
};

function rootYamlWithWatchdog(opts: { includeRetired?: boolean } = {}): string {
  return `version: '1'
custom_unknown_field: keep-me
llm:
  primary:
    preset: anthropic
    model: claude-sonnet-4-5
watchdog:
  interval_ms: 60000
  disk_warning_mb: 1024
  claw_inactivity_timeout_ms: 600000
${opts.includeRetired ? '  log_archive_days: 30\n' : ''}`;
}

const ROOT_YAML_NO_WATCHDOG = `version: '1'
custom_unknown_field: keep-me
`;

describe('phase 1289 Step B: watchdog config migration orchestration', () => {
  let workspaceRoot: string;
  let chestnutRoot: string;
  let configPath: string;

  beforeEach(() => {
    workspaceRoot = createTrackedTempDirSync('watchdog-migration-');
    chestnutRoot = path.join(workspaceRoot, '.chestnut');
    configPath = path.join(chestnutRoot, 'config.yaml');
    fs.mkdirSync(chestnutRoot, { recursive: true });
    vi.stubEnv('CHESTNUT_ROOT', workspaceRoot);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  function watchdogConfigOnDisk(): string | undefined {
    const p = path.join(chestnutRoot, WATCHDOG_PATHS.config);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : undefined;
  }

  it('not-initialized：无 root config.yaml → 不创建任何文件', () => {
    fs.rmSync(configPath, { force: true });
    expect(ensureWatchdogConfigMigrated(deps)).toEqual({ kind: 'not-initialized' });
    expect(fs.existsSync(path.join(chestnutRoot, WATCHDOG_PATHS.root))).toBe(false);
  });

  it('仅 legacy → migrated：新配置含 legacy 值、root YAML 其余字段语义不变、journal/layout 齐备', () => {
    fs.writeFileSync(configPath, rootYamlWithWatchdog());
    const result = ensureWatchdogConfigMigrated(deps);
    expect(result.kind).toBe('migrated');
    const migrationId = (result as { migrationId: string }).migrationId;
    expect(migrationId).toMatch(/^watchdog-config-relocation-[0-9a-f]{12}$/);

    // 新配置就位（typed 回读 + 拍板磁盘形态）
    expect(loadWorkspaceWatchdogConfig(fsFactory(chestnutRoot))).toEqual({ kind: 'ok', config: LEGACY_CUSTOM });
    expect(watchdogConfigOnDisk()).toBe(
      'schema_version: 1\ninterval_ms: 60000\ndisk_warning_mb: 1024\nclaw_inactivity_timeout_ms: 600000\n',
    );

    // legacy 段移除 + root YAML 其余字段逐字节语义保持、无 default 注入
    const after = yaml.load(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    expect(after.watchdog).toBeUndefined();
    expect(after.custom_unknown_field).toBe('keep-me');
    expect(after.version).toBe('1');
    expect((after.llm as any).primary.model).toBe('claude-sonnet-4-5');
    expect(after.audit, 'no schema default injection').toBeUndefined();

    // intent + outcome(completed, published) + layout
    const journal = readWatchdogMigrationJournal(fsFactory(chestnutRoot), migrationId);
    expect(journal.intent?.kind).toBe('watchdog-config-relocation');
    expect(journal.intent?.legacy).toEqual(LEGACY_CUSTOM);
    expect(journal.intent?.source.section).toBe('watchdog');
    expect(journal.intent?.source.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(journal.intent?.retired_fields).toBeUndefined();
    expect(journal.outcome).toMatchObject({ status: 'completed', published: true, legacy_removed: true });
    expect(fs.existsSync(path.join(chestnutRoot, WATCHDOG_PATHS.layout))).toBe(true);
    expect(findPendingWatchdogMigration(fsFactory(chestnutRoot))).toBeUndefined();
  });

  it('legacy 段含 log_archive_days → 捕获进 intent retired_fields，不进入新 config', () => {
    fs.writeFileSync(configPath, rootYamlWithWatchdog({ includeRetired: true }));
    const result = ensureWatchdogConfigMigrated(deps);
    expect(result.kind).toBe('migrated');
    const migrationId = (result as { migrationId: string }).migrationId;

    // 退役字段进 journal intent，不进新 config（typed schema 无此字段）
    const journal = readWatchdogMigrationJournal(fsFactory(chestnutRoot), migrationId);
    expect(journal.intent?.retired_fields).toEqual({ log_archive_days: 30 });
    expect(loadWorkspaceWatchdogConfig(fsFactory(chestnutRoot))).toEqual({ kind: 'ok', config: LEGACY_CUSTOM });
    expect(watchdogConfigOnDisk()).not.toContain('log_archive_days');
    // legacy 段整体移除（含退役字段原文）
    const after = yaml.load(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    expect(after.watchdog).toBeUndefined();
  });

  it('仅新配置 → already，不产生 journal', () => {
    fs.writeFileSync(configPath, ROOT_YAML_NO_WATCHDOG);
    publishMigratedWorkspaceWatchdogConfig(fsFactory(chestnutRoot), LEGACY_CUSTOM, 'x'.repeat(64));
    expect(ensureWatchdogConfigMigrated(deps)).toEqual({ kind: 'already' });
    expect(fs.existsSync(path.join(chestnutRoot, WATCHDOG_PATHS.migrations))).toBe(false);
  });

  it('两边同值 → migrated：删 legacy、新配置不重写（published=false）', () => {
    fs.writeFileSync(configPath, rootYamlWithWatchdog());
    publishMigratedWorkspaceWatchdogConfig(fsFactory(chestnutRoot), LEGACY_CUSTOM, 'x'.repeat(64));
    const configBefore = watchdogConfigOnDisk();

    const result = ensureWatchdogConfigMigrated(deps);
    expect(result.kind).toBe('migrated');
    expect(watchdogConfigOnDisk()).toBe(configBefore);
    const after = yaml.load(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    expect(after.watchdog).toBeUndefined();
    const journal = readWatchdogMigrationJournal(fsFactory(chestnutRoot), (result as { migrationId: string }).migrationId);
    expect(journal.outcome).toMatchObject({ status: 'completed', published: false, legacy_removed: true });
  });

  it('两边冲突 → fail-loud 抛错、双方保留、journal 留 conflict outcome；重跑同 id 持久失败', () => {
    fs.writeFileSync(configPath, rootYamlWithWatchdog());
    publishMigratedWorkspaceWatchdogConfig(
      fsFactory(chestnutRoot),
      { interval_ms: 60000, disk_warning_mb: 2048, claw_inactivity_timeout_ms: 600000 },
      'x'.repeat(64),
    );
    const configBefore = watchdogConfigOnDisk();
    const rootBefore = fs.readFileSync(configPath, 'utf8');

    expect(() => ensureWatchdogConfigMigrated(deps)).toThrow(/Watchdog config conflict/);
    // 双方保留
    expect(watchdogConfigOnDisk()).toBe(configBefore);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(rootBefore);
    // journal 留证
    const rootFs = fsFactory(chestnutRoot);
    const entries = fs.readdirSync(path.join(chestnutRoot, WATCHDOG_PATHS.migrations));
    expect(entries).toHaveLength(1);
    const journal = readWatchdogMigrationJournal(rootFs, entries[0]);
    expect(journal.intent).toBeDefined();
    expect(journal.outcome?.status).toBe('conflict');

    // 重跑：同 migration id（content-derived）、持久 fail-loud、不产生第二个 journal 目录
    expect(() => ensureWatchdogConfigMigrated(deps)).toThrow(new RegExp(entries[0]));
    expect(fs.readdirSync(path.join(chestnutRoot, WATCHDOG_PATHS.migrations))).toHaveLength(1);
  });

  it('两边皆无 → missing：typed 报告、不静默创建', () => {
    fs.writeFileSync(configPath, ROOT_YAML_NO_WATCHDOG);
    expect(ensureWatchdogConfigMigrated(deps)).toEqual({ kind: 'missing' });
    expect(fs.existsSync(path.join(chestnutRoot, WATCHDOG_PATHS.root))).toBe(false);
  });

  it('新配置 invalid → fail-loud 抛错', () => {
    fs.writeFileSync(configPath, ROOT_YAML_NO_WATCHDOG);
    fs.mkdirSync(path.join(chestnutRoot, WATCHDOG_PATHS.root), { recursive: true });
    fs.writeFileSync(path.join(chestnutRoot, WATCHDOG_PATHS.config), 'schema_version: 2\n');
    expect(() => ensureWatchdogConfigMigrated(deps)).toThrow(/invalid/);
  });

  it('中断恢复：crash 于 publish 前（仅 intent + legacy）→ 同 id 续跑完成', () => {
    fs.writeFileSync(configPath, rootYamlWithWatchdog());
    const rootFs = fsFactory(chestnutRoot);
    writeWatchdogMigrationIntent(rootFs, {
      schema_version: WATCHDOG_LAYOUT_SCHEMA_VERSION,
      migration_id: 'crash-before-publish',
      kind: 'watchdog-config-relocation',
      created_at: new Date().toISOString(),
      source: { path: configPath, section: 'watchdog', sha256: 'f'.repeat(64) },
      legacy: LEGACY_CUSTOM,
    });

    const result = ensureWatchdogConfigMigrated(deps);
    expect(result).toEqual({ kind: 'migrated', migrationId: 'crash-before-publish' });
    expect(loadWorkspaceWatchdogConfig(rootFs)).toEqual({ kind: 'ok', config: LEGACY_CUSTOM });
    expect((yaml.load(fs.readFileSync(configPath, 'utf8')) as any).watchdog).toBeUndefined();
    expect(readWatchdogMigrationJournal(rootFs, 'crash-before-publish').outcome?.status).toBe('completed');
  });

  it('中断恢复：crash 于删 legacy 前（intent + 新配置 + legacy 同值）→ 续跑删 legacy', () => {
    fs.writeFileSync(configPath, rootYamlWithWatchdog());
    const rootFs = fsFactory(chestnutRoot);
    writeWatchdogMigrationIntent(rootFs, {
      schema_version: WATCHDOG_LAYOUT_SCHEMA_VERSION,
      migration_id: 'crash-after-publish',
      kind: 'watchdog-config-relocation',
      created_at: new Date().toISOString(),
      source: { path: configPath, section: 'watchdog', sha256: 'f'.repeat(64) },
      legacy: LEGACY_CUSTOM,
    });
    publishMigratedWorkspaceWatchdogConfig(rootFs, LEGACY_CUSTOM, 'f'.repeat(64));

    const result = ensureWatchdogConfigMigrated(deps);
    expect(result).toEqual({ kind: 'migrated', migrationId: 'crash-after-publish' });
    expect((yaml.load(fs.readFileSync(configPath, 'utf8')) as any).watchdog).toBeUndefined();
    expect(readWatchdogMigrationJournal(rootFs, 'crash-after-publish').outcome).toMatchObject({
      status: 'completed', legacy_removed: true,
    });
  });

  it('中断恢复：crash 于 outcome 前（新配置在、legacy 已删、仅 intent）→ 补 outcome/layout 报 already', () => {
    fs.writeFileSync(configPath, ROOT_YAML_NO_WATCHDOG);
    const rootFs = fsFactory(chestnutRoot);
    writeWatchdogMigrationIntent(rootFs, {
      schema_version: WATCHDOG_LAYOUT_SCHEMA_VERSION,
      migration_id: 'crash-before-outcome',
      kind: 'watchdog-config-relocation',
      created_at: new Date().toISOString(),
      source: { path: configPath, section: 'watchdog', sha256: 'f'.repeat(64) },
      legacy: LEGACY_CUSTOM,
    });
    publishMigratedWorkspaceWatchdogConfig(rootFs, LEGACY_CUSTOM, 'f'.repeat(64));

    expect(ensureWatchdogConfigMigrated(deps)).toEqual({ kind: 'already' });
    expect(readWatchdogMigrationJournal(rootFs, 'crash-before-outcome').outcome?.status).toBe('completed');
    expect(fs.existsSync(path.join(chestnutRoot, WATCHDOG_PATHS.layout))).toBe(true);
    expect(findPendingWatchdogMigration(rootFs)).toBeUndefined();
  });

  it('幂等重入：迁移完成后第二次运行 → already、状态不变', () => {
    fs.writeFileSync(configPath, rootYamlWithWatchdog());
    const first = ensureWatchdogConfigMigrated(deps);
    expect(first.kind).toBe('migrated');
    const configAfterFirst = watchdogConfigOnDisk();
    const rootAfterFirst = fs.readFileSync(configPath, 'utf8');

    expect(ensureWatchdogConfigMigrated(deps)).toEqual({ kind: 'already' });
    expect(watchdogConfigOnDisk()).toBe(configAfterFirst);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(rootAfterFirst);
  });
});
