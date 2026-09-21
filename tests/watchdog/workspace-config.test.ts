/**
 * Phase 1289 Step B: Watchdog workspace config store（.chestnut/watchdog/config.yaml）
 *
 * 覆盖：
 * - loadWorkspaceWatchdogConfig：missing / ok / invalid（读失败、YAML 错、schema 错），不静默创建
 * - readWorkspaceWatchdogConfig：ok → 值；missing → throw fail-loud；invalid → throw
 * - initWorkspaceWatchdogConfig：fresh 创建默认（精确磁盘形态）+ 回读；已存在 → already 不覆盖；invalid → throw
 * - publishWatchdogLayout：layout.json 磁盘形态（phase 1890 Step J 自 config-migration-journal 收编）
 *
 * phase 1890 Step J：publishMigratedWorkspaceWatchdogConfig / ConflictError 随迁移协议删除。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { WATCHDOG_LAYOUT_SCHEMA_VERSION, WATCHDOG_PATHS } from '../../src/watchdog/layout.js';
import type { WatchdogConfig } from '../../src/watchdog/config-schema.js';
import {
  loadWorkspaceWatchdogConfig,
  readWorkspaceWatchdogConfig,
  initWorkspaceWatchdogConfig,
  publishWatchdogLayout,
} from '../../src/watchdog/workspace-config.js';
import { createTrackedTempDirSync } from '../utils/temp.js';

const fsFactory = (baseDir: string) => new NodeFileSystem({ baseDir });

const LEGACY_DEFAULT: WatchdogConfig = {
  interval_ms: 30000,
  heartbeat_stale_timeout_ms: 180000,
};
const LEGACY_CUSTOM: WatchdogConfig = {
  interval_ms: 60000,
  heartbeat_stale_timeout_ms: 240000,
};

describe('phase 1289 Step B: workspace watchdog config store', () => {
  let chestnutRoot: string;

  beforeEach(() => {
    chestnutRoot = createTrackedTempDirSync('watchdog-ws-config-');
  });

  afterEach(() => {
    fs.rmSync(chestnutRoot, { recursive: true, force: true });
  });

  function readConfigFile(): string {
    return fs.readFileSync(path.join(chestnutRoot, WATCHDOG_PATHS.config), 'utf8');
  }

  /** 直接以拍板磁盘形态种子一个自定义 config（替代已删的迁移 publish 面）。 */
  function seedCustomConfig(): void {
    fs.mkdirSync(path.join(chestnutRoot, WATCHDOG_PATHS.root), { recursive: true });
    fs.writeFileSync(
      path.join(chestnutRoot, WATCHDOG_PATHS.config),
      'schema_version: 1\ninterval_ms: 60000\nheartbeat_stale_timeout_ms: 240000\n',
    );
  }

  describe('loadWorkspaceWatchdogConfig', () => {
    it('文件不存在 → missing，且不创建任何文件', () => {
      const result = loadWorkspaceWatchdogConfig(fsFactory(chestnutRoot));
      expect(result).toEqual({ kind: 'missing' });
      expect(fs.existsSync(path.join(chestnutRoot, WATCHDOG_PATHS.config))).toBe(false);
    });

    it('合法文件 → ok + typed WatchdogConfig', () => {
      initWorkspaceWatchdogConfig(fsFactory(chestnutRoot));
      const result = loadWorkspaceWatchdogConfig(fsFactory(chestnutRoot));
      expect(result).toEqual({ kind: 'ok', config: LEGACY_DEFAULT });
    });

    it('YAML 语法错 → invalid', () => {
      fs.mkdirSync(path.join(chestnutRoot, WATCHDOG_PATHS.root), { recursive: true });
      fs.writeFileSync(path.join(chestnutRoot, WATCHDOG_PATHS.config), 'interval_ms: [unclosed\n');
      const result = loadWorkspaceWatchdogConfig(fsFactory(chestnutRoot));
      expect(result.kind).toBe('invalid');
    });

    it('schema 校验失败（未知 schema_version fail-closed / interval_ms 低于 min）→ invalid', () => {
      fs.mkdirSync(path.join(chestnutRoot, WATCHDOG_PATHS.root), { recursive: true });
      fs.writeFileSync(
        path.join(chestnutRoot, WATCHDOG_PATHS.config),
        'schema_version: 2\ninterval_ms: 30000\nheartbeat_stale_timeout_ms: 180000\n',
      );
      expect(loadWorkspaceWatchdogConfig(fsFactory(chestnutRoot)).kind).toBe('invalid');
      fs.writeFileSync(
        path.join(chestnutRoot, WATCHDOG_PATHS.config),
        'schema_version: 1\ninterval_ms: 100\nheartbeat_stale_timeout_ms: 180000\n',
      );
      expect(loadWorkspaceWatchdogConfig(fsFactory(chestnutRoot)).kind).toBe('invalid');
    });

    it('phase 1878 Step C：旧文件含已退役字段 → 读取不报错、字段显式忽略（视作已退役）', () => {
      fs.mkdirSync(path.join(chestnutRoot, WATCHDOG_PATHS.root), { recursive: true });
      fs.writeFileSync(
        path.join(chestnutRoot, WATCHDOG_PATHS.config),
        'schema_version: 1\ninterval_ms: 30000\ndisk_warning_mb: 500\nclaw_inactivity_timeout_ms: 300000\nheartbeat_stale_timeout_ms: 240000\n',
      );
      const result = loadWorkspaceWatchdogConfig(fsFactory(chestnutRoot));
      expect(result).toEqual({
        kind: 'ok',
        config: { interval_ms: 30000, heartbeat_stale_timeout_ms: 240000 },
      });
    });

    it('phase 1878 Step C：旧文件缺 heartbeat_stale_timeout_ms → schema default 填充', () => {
      fs.mkdirSync(path.join(chestnutRoot, WATCHDOG_PATHS.root), { recursive: true });
      fs.writeFileSync(
        path.join(chestnutRoot, WATCHDOG_PATHS.config),
        'schema_version: 1\ninterval_ms: 30000\ndisk_warning_mb: 500\nclaw_inactivity_timeout_ms: 300000\n',
      );
      expect(loadWorkspaceWatchdogConfig(fsFactory(chestnutRoot))).toEqual({
        kind: 'ok',
        config: LEGACY_DEFAULT,
      });
    });

    it('heartbeat_stale_timeout_ms 低于 min（1 tick = 60s）→ invalid', () => {
      fs.mkdirSync(path.join(chestnutRoot, WATCHDOG_PATHS.root), { recursive: true });
      fs.writeFileSync(
        path.join(chestnutRoot, WATCHDOG_PATHS.config),
        'schema_version: 1\ninterval_ms: 30000\nheartbeat_stale_timeout_ms: 30000\n',
      );
      expect(loadWorkspaceWatchdogConfig(fsFactory(chestnutRoot)).kind).toBe('invalid');
    });
  });

  describe('readWorkspaceWatchdogConfig', () => {
    it('missing → throw fail-loud（普通启动不静默创建默认）', () => {
      expect(() => readWorkspaceWatchdogConfig(fsFactory(chestnutRoot))).toThrow(
        new RegExp(`missing \\(${WATCHDOG_PATHS.config.replace(/[/.]/g, '\\$&')}\\)`),
      );
    });

    it('ok → 配置值', () => {
      seedCustomConfig();
      expect(readWorkspaceWatchdogConfig(fsFactory(chestnutRoot))).toEqual(LEGACY_CUSTOM);
    });

    it('invalid → throw（fail-loud）', () => {
      fs.mkdirSync(path.join(chestnutRoot, WATCHDOG_PATHS.root), { recursive: true });
      fs.writeFileSync(path.join(chestnutRoot, WATCHDOG_PATHS.config), 'schema_version: 2\n');
      expect(() => readWorkspaceWatchdogConfig(fsFactory(chestnutRoot))).toThrow(/Invalid workspace watchdog config/);
    });
  });

  describe('initWorkspaceWatchdogConfig', () => {
    it('fresh init 创建默认配置、磁盘形态与拍板一致（key 顺序固定）', () => {
      expect(initWorkspaceWatchdogConfig(fsFactory(chestnutRoot))).toBe('created');
      expect(readConfigFile()).toBe(
        'schema_version: 1\ninterval_ms: 30000\nheartbeat_stale_timeout_ms: 180000\n',
      );
    });

    it('已存在 → already，不覆盖现有内容', () => {
      seedCustomConfig();
      const before = readConfigFile();
      expect(initWorkspaceWatchdogConfig(fsFactory(chestnutRoot))).toBe('already');
      expect(readConfigFile()).toBe(before);
    });

    it('已存在但 invalid → throw，不静默抹掉', () => {
      fs.mkdirSync(path.join(chestnutRoot, WATCHDOG_PATHS.root), { recursive: true });
      fs.writeFileSync(path.join(chestnutRoot, WATCHDOG_PATHS.config), 'garbage: [');
      expect(() => initWorkspaceWatchdogConfig(fsFactory(chestnutRoot))).toThrow(/invalid/);
    });
  });

  describe('publishWatchdogLayout', () => {
    it('写 layout.json：schema_version + owner + resources 账本（Phase 1455 Step C ratchet）', () => {
      const rootFs = fsFactory(chestnutRoot);
      publishWatchdogLayout(rootFs);
      const layout = JSON.parse(fs.readFileSync(path.join(chestnutRoot, WATCHDOG_PATHS.layout), 'utf8'));
      expect(layout.schema_version).toBe(WATCHDOG_LAYOUT_SCHEMA_VERSION);
      expect(layout.owner).toBe('watchdog');
      expect(typeof layout.updated_at).toBe('string');
      expect(layout.resources).toEqual({
        config: 'migrated',
        state: 'migrated',
        log: 'migrated',
        subscriptions: 'retired',
      });
    });
  });
});
