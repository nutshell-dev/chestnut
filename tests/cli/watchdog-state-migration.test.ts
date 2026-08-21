/**
 * Phase 1455 Step A: CLIProcess state 迁移编排矩阵（ensureWatchdogStateMigrated）。
 *
 * 矩阵：
 * - not-initialized（无 root config.yaml）→ 不动任何文件
 * - 双方皆无 → missing（不静默创建）
 * - 仅 legacy → migrated：新路径逐字节等于 legacy 原文 + intent/outcome(published)/
 *   layout 齐备 + legacy 保留（清退归 Step C）
 * - 迁移完成后重入（双方并存 + completed journal + 内容漂移）→ already
 * - 仅新 → already（无 journal）
 * - 中断恢复：仅 intent（crash 于 publish 前）→ 幂等续跑完成；
 *   publish 后（crash 于 outcome 前、字节相同）→ 补 outcome 收口
 * - 双方皆在 + 无 completed journal + 内容不同 → fail-loud 抛错、双方保留、
 *   conflict outcome 留证；重跑持续 fail-loud
 * - migrations/ 目录共享隔离：config pending intent 不被 state 迁移误认（kind 过滤）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { ensureWatchdogStateMigrated } from '../../src/cli/watchdog-state-migration.js';
import { WATCHDOG_PATHS, WATCHDOG_LAYOUT_SCHEMA_VERSION } from '../../src/watchdog/layout.js';
import { createWatchdogStateMigration } from '../../src/watchdog/state-migration.js';
import { findPendingWatchdogMigration } from '../../src/watchdog/config-migration-journal.js';
import { createTrackedTempDirSync } from '../utils/temp.js';
import { createRootConfig } from '../../src/assembly/index.js';

const fsFactory = (baseDir: string) => new NodeFileSystem({ baseDir });
const deps = {
  fsFactory,
  rootConfig: createRootConfig({ fsFactory }),
};

const LEGACY_STATE = JSON.stringify({
  schema_version: 3,
  motionRestart: { status: 'closed', consecutiveAttempts: 0 },
  executorRestart: { claw1: { status: 'open', consecutiveAttempts: 2, openedAt: 1234567000 } },
}, null, 2);

describe('phase 1455 Step A: watchdog state migration orchestration', () => {
  let workspaceRoot: string;
  let chestnutRoot: string;
  let configPath: string;
  let legacyPath: string;
  let newPath: string;

  beforeEach(() => {
    workspaceRoot = createTrackedTempDirSync('watchdog-state-migration-');
    chestnutRoot = path.join(workspaceRoot, '.chestnut');
    configPath = path.join(chestnutRoot, 'config.yaml');
    legacyPath = path.join(chestnutRoot, 'watchdog-state.json');
    newPath = path.join(chestnutRoot, WATCHDOG_PATHS.state);
    fs.mkdirSync(chestnutRoot, { recursive: true });
    fs.writeFileSync(configPath, "version: '1'\n");
    vi.stubEnv('CHESTNUT_ROOT', workspaceRoot);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  function migrationDirs(): string[] {
    const dir = path.join(chestnutRoot, WATCHDOG_PATHS.migrations);
    return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
  }

  it('not-initialized：无 root config.yaml → 不动任何文件', () => {
    fs.rmSync(configPath, { force: true });
    fs.writeFileSync(legacyPath, LEGACY_STATE);
    expect(ensureWatchdogStateMigrated(deps)).toEqual({ kind: 'not-initialized' });
    expect(fs.existsSync(newPath)).toBe(false);
    expect(migrationDirs()).toEqual([]);
  });

  it('双方皆无 → missing：不静默创建、无 journal', () => {
    expect(ensureWatchdogStateMigrated(deps)).toEqual({ kind: 'missing' });
    expect(fs.existsSync(newPath)).toBe(false);
    expect(migrationDirs()).toEqual([]);
  });

  it('仅 legacy → migrated：新路径逐字节一致 + journal/layout 齐备 + legacy 清退（Step C）', () => {
    fs.writeFileSync(legacyPath, LEGACY_STATE);
    const result = ensureWatchdogStateMigrated(deps);
    expect(result.kind).toBe('migrated');
    const migrationId = (result as { migrationId: string }).migrationId;
    expect(migrationId).toMatch(/^watchdog-state-relocation-[0-9a-f]{12}$/);

    // 新路径就位且逐字节等于 legacy 原文
    expect(fs.readFileSync(newPath, 'utf8')).toBe(LEGACY_STATE);
    // Step C：outcome 回读验证后 legacy 清退
    expect(fs.existsSync(legacyPath)).toBe(false);

    // intent + outcome(completed, published=true) + layout
    const journal = createWatchdogStateMigration(fsFactory(chestnutRoot)).readJournal(migrationId);
    expect(journal.intent?.kind).toBe('watchdog-state-relocation');
    expect(journal.intent?.schema_version).toBe(WATCHDOG_LAYOUT_SCHEMA_VERSION);
    expect(journal.intent?.source.path).toBe('watchdog-state.json');
    expect(journal.outcome?.status).toBe('completed');
    expect(journal.outcome?.published).toBe(true);
    expect(fs.existsSync(path.join(chestnutRoot, WATCHDOG_PATHS.layout))).toBe(true);
  });

  it('迁移完成后重入（completed journal + legacy 残留 + 内容漂移）→ already + 清退 legacy、journal 不增殖', () => {
    fs.writeFileSync(legacyPath, LEGACY_STATE);
    const first = ensureWatchdogStateMigrated(deps);
    expect(first.kind).toBe('migrated');
    const migrationId = (first as { migrationId: string }).migrationId;

    // 模拟 Step A 窗口遗留：legacy 仍在（Step C 前的安装）+ 生产写漂移
    fs.writeFileSync(legacyPath, LEGACY_STATE);
    fs.writeFileSync(newPath, JSON.stringify({ schema_version: 3, motionRestart: { status: 'open', consecutiveAttempts: 1, openedAt: 42 } }));

    expect(ensureWatchdogStateMigrated(deps)).toEqual({ kind: 'already' });
    expect(migrationDirs()).toHaveLength(1);
    // Step C：completed journal 下 legacy 残留被清退
    expect(fs.existsSync(legacyPath)).toBe(false);
  });

  it('仅新路径 → already（无 journal）', () => {
    fs.mkdirSync(path.dirname(newPath), { recursive: true });
    fs.writeFileSync(newPath, LEGACY_STATE);
    expect(ensureWatchdogStateMigrated(deps)).toEqual({ kind: 'already' });
    expect(migrationDirs()).toEqual([]);
  });

  it('中断恢复：仅 intent（crash 于 publish 前）→ 幂等续跑完成', () => {
    fs.writeFileSync(legacyPath, LEGACY_STATE);
    // 手工造 pending：先跑到 migrated 再恢复 legacy + 删 outcome/新路径，模拟 crash 于 publish 前
    const first = ensureWatchdogStateMigrated(deps);
    const migrationId = (first as { migrationId: string }).migrationId;
    fs.writeFileSync(legacyPath, LEGACY_STATE);
    fs.rmSync(newPath, { force: true });
    fs.rmSync(path.join(chestnutRoot, WATCHDOG_PATHS.migrations, migrationId, 'outcome.json'));

    const resumed = ensureWatchdogStateMigrated(deps);
    expect(resumed).toEqual({ kind: 'migrated', migrationId });
    expect(fs.readFileSync(newPath, 'utf8')).toBe(LEGACY_STATE);
    const journal = createWatchdogStateMigration(fsFactory(chestnutRoot)).readJournal(migrationId);
    expect(journal.outcome?.status).toBe('completed');
    expect(journal.outcome?.published).toBe(true);
  });

  it('中断恢复：publish 后 crash 于 outcome 前（双方字节相同）→ 补 outcome 收口', () => {
    fs.writeFileSync(legacyPath, LEGACY_STATE);
    const first = ensureWatchdogStateMigrated(deps);
    const migrationId = (first as { migrationId: string }).migrationId;
    // 模拟 crash 于 outcome 前：双方皆在、字节相同、无 outcome
    fs.writeFileSync(legacyPath, LEGACY_STATE);
    fs.rmSync(path.join(chestnutRoot, WATCHDOG_PATHS.migrations, migrationId, 'outcome.json'));

    const resumed = ensureWatchdogStateMigrated(deps);
    expect(resumed).toEqual({ kind: 'migrated', migrationId });
    const journal = createWatchdogStateMigration(fsFactory(chestnutRoot)).readJournal(migrationId);
    expect(journal.outcome?.status).toBe('completed');
    expect(journal.outcome?.published).toBe(false);
  });

  it('双方皆在 + 无 completed journal + 内容不同 → conflict fail-loud、双方保留、重跑持续 fail-loud', () => {
    fs.writeFileSync(legacyPath, LEGACY_STATE);
    fs.mkdirSync(path.dirname(newPath), { recursive: true });
    fs.writeFileSync(newPath, JSON.stringify({ schema_version: 3, motionRestart: { status: 'open', consecutiveAttempts: 9, openedAt: 1 } }));

    expect(() => ensureWatchdogStateMigrated(deps)).toThrow(/Watchdog state conflict/);
    // 双方保留
    expect(fs.readFileSync(legacyPath, 'utf8')).toBe(LEGACY_STATE);
    // conflict outcome 留证
    const dirs = migrationDirs();
    expect(dirs).toHaveLength(1);
    const journal = createWatchdogStateMigration(fsFactory(chestnutRoot)).readJournal(dirs[0]);
    expect(journal.outcome?.status).toBe('conflict');
    // 重跑同 id 持久 fail-loud
    expect(() => ensureWatchdogStateMigrated(deps)).toThrow(/Watchdog state conflict/);
    expect(migrationDirs()).toEqual(dirs);
  });

  it('Step C：logs/watchdog.log 与 watchdog-subscriptions/ 在迁移终态后清退（幂等）', () => {
    // 造 legacy 三件套
    fs.writeFileSync(legacyPath, LEGACY_STATE);
    const legacyLog = path.join(chestnutRoot, 'logs', 'watchdog.log');
    fs.mkdirSync(path.dirname(legacyLog), { recursive: true });
    fs.writeFileSync(legacyLog, '[old] line\n');
    const legacySubs = path.join(chestnutRoot, 'watchdog-subscriptions');
    fs.mkdirSync(legacySubs, { recursive: true });
    fs.writeFileSync(path.join(legacySubs, 'sub.json'), '{}');

    expect(ensureWatchdogStateMigrated(deps).kind).toBe('migrated');
    expect(fs.existsSync(legacyPath)).toBe(false);
    expect(fs.existsSync(legacyLog)).toBe(false);
    expect(fs.existsSync(legacySubs)).toBe(false);

    // 重入幂等：不缺文件不报错、终态 already
    expect(ensureWatchdogStateMigrated(deps)).toEqual({ kind: 'already' });
  });

  it('Step C：conflict 时不清退任何 legacy（双方保留含 log/subscriptions）', () => {
    fs.writeFileSync(legacyPath, LEGACY_STATE);
    fs.mkdirSync(path.dirname(newPath), { recursive: true });
    fs.writeFileSync(newPath, JSON.stringify({ schema_version: 3, motionRestart: { status: 'open', consecutiveAttempts: 9, openedAt: 1 } }));
    const legacyLog = path.join(chestnutRoot, 'logs', 'watchdog.log');
    fs.mkdirSync(path.dirname(legacyLog), { recursive: true });
    fs.writeFileSync(legacyLog, '[old] line\n');

    expect(() => ensureWatchdogStateMigrated(deps)).toThrow(/Watchdog state conflict/);
    expect(fs.existsSync(legacyPath)).toBe(true);
    expect(fs.existsSync(legacyLog)).toBe(true);
  });

  it('migrations/ 目录共享隔离：config pending intent 不被 state/config 双方误认', () => {
    // 造一个 config kind 的 pending journal（模拟 config 迁移 crash 中）
    const configDir = path.join(chestnutRoot, WATCHDOG_PATHS.migrations, 'watchdog-config-relocation-deadbeef0000');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'intent.json'), JSON.stringify({
      schema_version: 1,
      migration_id: 'watchdog-config-relocation-deadbeef0000',
      kind: 'watchdog-config-relocation',
      created_at: new Date().toISOString(),
      source: { path: '/x/config.yaml', section: 'watchdog', sha256: 'deadbeef' },
      legacy: { interval_ms: 1, disk_warning_mb: 1, claw_inactivity_timeout_ms: 1 },
    }));

    // state 迁移：正常推进自己的迁移，不误认 config pending
    fs.writeFileSync(legacyPath, LEGACY_STATE);
    const result = ensureWatchdogStateMigrated(deps);
    expect(result.kind).toBe('migrated');
    expect((result as { migrationId: string }).migrationId).not.toContain('config');
    // config journal 未被写 outcome
    expect(fs.existsSync(path.join(configDir, 'outcome.json'))).toBe(false);

    // config 侧 findPending 也不误认 state pending：再造一个 state pending
    const stateDir = path.join(chestnutRoot, WATCHDOG_PATHS.migrations, 'watchdog-state-relocation-cafebabe0000');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'intent.json'), JSON.stringify({
      schema_version: 1,
      migration_id: 'watchdog-state-relocation-cafebabe0000',
      kind: 'watchdog-state-relocation',
      created_at: new Date().toISOString(),
      source: { path: 'watchdog-state.json', sha256: 'cafebabe' },
    }));
    const pending = findPendingWatchdogMigration(fsFactory(chestnutRoot));
    expect(pending?.migrationId).toBe('watchdog-config-relocation-deadbeef0000');
  });
});
