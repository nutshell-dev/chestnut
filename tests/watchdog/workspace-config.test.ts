/**
 * Phase 1289 Step B: Watchdog workspace config store（.chestnut/watchdog/config.yaml）
 *
 * 覆盖：
 * - loadWorkspaceWatchdogConfig：missing / ok / invalid（读失败、YAML 错、schema 错），不静默创建
 * - readWorkspaceWatchdogConfig：ok → 值；missing → throw fail-loud；invalid → throw
 * - initWorkspaceWatchdogConfig：fresh 创建默认（精确磁盘形态）+ 回读；已存在 → already 不覆盖；invalid → throw
 * - publishMigratedWorkspaceWatchdogConfig：exclusive publish + 回读；同值幂等；异值 conflict 双方保留
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { WATCHDOG_PATHS } from '../../src/watchdog/layout.js';
import type { WatchdogConfig } from '../../src/watchdog/config-schema.js';
import {
  loadWorkspaceWatchdogConfig,
  readWorkspaceWatchdogConfig,
  initWorkspaceWatchdogConfig,
  publishMigratedWorkspaceWatchdogConfig,
  WatchdogWorkspaceConfigConflictError,
} from '../../src/watchdog/workspace-config.js';
import { createTrackedTempDirSync } from '../utils/temp.js';

const fsFactory = (baseDir: string) => new NodeFileSystem({ baseDir });

const LEGACY_DEFAULT: WatchdogConfig = {
  interval_ms: 30000,
  disk_warning_mb: 500,
};
const LEGACY_CUSTOM: WatchdogConfig = {
  interval_ms: 60000,
  disk_warning_mb: 1024,
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
        'schema_version: 2\ninterval_ms: 30000\ndisk_warning_mb: 500\n',
      );
      expect(loadWorkspaceWatchdogConfig(fsFactory(chestnutRoot)).kind).toBe('invalid');
      fs.writeFileSync(
        path.join(chestnutRoot, WATCHDOG_PATHS.config),
        'schema_version: 1\ninterval_ms: 100\ndisk_warning_mb: 500\n',
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
      publishMigratedWorkspaceWatchdogConfig(fsFactory(chestnutRoot), LEGACY_CUSTOM, 'deadbeef');
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
        'schema_version: 1\ninterval_ms: 30000\ndisk_warning_mb: 500\n',
      );
    });

    it('已存在 → already，不覆盖现有内容', () => {
      publishMigratedWorkspaceWatchdogConfig(fsFactory(chestnutRoot), LEGACY_CUSTOM, 'deadbeef');
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

  describe('publishMigratedWorkspaceWatchdogConfig', () => {
    it('不存在 → published，写入 legacy 值并可读回（key 顺序固定）', () => {
      expect(publishMigratedWorkspaceWatchdogConfig(fsFactory(chestnutRoot), LEGACY_CUSTOM, 'deadbeef')).toBe('published');
      expect(readConfigFile()).toBe(
        'schema_version: 1\ninterval_ms: 60000\ndisk_warning_mb: 1024\n',
      );
      expect(loadWorkspaceWatchdogConfig(fsFactory(chestnutRoot))).toEqual({ kind: 'ok', config: LEGACY_CUSTOM });
    });

    it('已存在且同值 → already-present，文件不被重写', () => {
      publishMigratedWorkspaceWatchdogConfig(fsFactory(chestnutRoot), LEGACY_CUSTOM, 'deadbeef');
      const before = readConfigFile();
      expect(publishMigratedWorkspaceWatchdogConfig(fsFactory(chestnutRoot), LEGACY_CUSTOM, 'deadbeef')).toBe('already-present');
      expect(readConfigFile()).toBe(before);
    });

    it('已存在且异值 → ConflictError，双方保留（文件不被改写）', () => {
      publishMigratedWorkspaceWatchdogConfig(fsFactory(chestnutRoot), LEGACY_CUSTOM, 'deadbeef');
      const before = readConfigFile();
      const attempt = () => publishMigratedWorkspaceWatchdogConfig(fsFactory(chestnutRoot), LEGACY_DEFAULT, 'cafe');
      expect(attempt).toThrow(WatchdogWorkspaceConfigConflictError);
      expect(attempt).toThrow(/Both preserved/);
      expect(readConfigFile()).toBe(before);
    });

    it('已存在但 invalid → throw', () => {
      fs.mkdirSync(path.join(chestnutRoot, WATCHDOG_PATHS.root), { recursive: true });
      fs.writeFileSync(path.join(chestnutRoot, WATCHDOG_PATHS.config), 'schema_version: 9\n');
      expect(() => publishMigratedWorkspaceWatchdogConfig(fsFactory(chestnutRoot), LEGACY_CUSTOM, 'deadbeef')).toThrow(/invalid/);
    });
  });
});
