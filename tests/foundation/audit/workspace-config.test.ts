/**
 * Phase 1288 Step B: AuditLog workspace config store（.chestnut/audit/config.yaml）
 *
 * 覆盖：
 * - loadWorkspaceAuditConfig：missing / ok / invalid（读失败、YAML 错、schema 错），不静默创建
 * - readWorkspaceAuditRetentionMaxSizeMb：ok → 值；missing → null；invalid → throw
 * - initWorkspaceAuditConfig：fresh 创建默认（精确磁盘形态）+ 回读；已存在 → already 不覆盖；invalid → throw
 * - publishMigratedWorkspaceAuditConfig：exclusive publish + 回读；同值幂等；异值 conflict 双方保留
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import {
  loadWorkspaceAuditConfig,
  readWorkspaceAuditRetentionMaxSizeMb,
  initWorkspaceAuditConfig,
  publishMigratedWorkspaceAuditConfig,
  AuditWorkspaceConfigConflictError,
  AUDIT_PATHS,
  type AuditConfig,
} from '../../../src/foundation/audit/index.js';
import { createTrackedTempDirSync } from '../../utils/temp.js';

const fsFactory = (baseDir: string) => new NodeFileSystem({ baseDir });

const LEGACY_DEFAULT: AuditConfig = { retention: { max_size_mb: null } };
const LEGACY_64: AuditConfig = { retention: { max_size_mb: 64 } };

describe('phase 1288 Step B: workspace audit config store', () => {
  let chestnutRoot: string;

  beforeEach(() => {
    chestnutRoot = createTrackedTempDirSync('audit-ws-config-');
  });

  afterEach(() => {
    fs.rmSync(chestnutRoot, { recursive: true, force: true });
  });

  function readConfigFile(): string {
    return fs.readFileSync(path.join(chestnutRoot, AUDIT_PATHS.config), 'utf8');
  }

  describe('loadWorkspaceAuditConfig', () => {
    it('文件不存在 → missing，且不创建任何文件', () => {
      const result = loadWorkspaceAuditConfig(fsFactory(chestnutRoot));
      expect(result).toEqual({ kind: 'missing' });
      expect(fs.existsSync(path.join(chestnutRoot, AUDIT_PATHS.config))).toBe(false);
    });

    it('合法文件 → ok + typed AuditConfig', () => {
      initWorkspaceAuditConfig(fsFactory(chestnutRoot));
      const result = loadWorkspaceAuditConfig(fsFactory(chestnutRoot));
      expect(result).toEqual({ kind: 'ok', config: LEGACY_DEFAULT });
    });

    it('YAML 语法错 → invalid', () => {
      fs.mkdirSync(path.join(chestnutRoot, AUDIT_PATHS.root), { recursive: true });
      fs.writeFileSync(path.join(chestnutRoot, AUDIT_PATHS.config), 'retention: [unclosed\n');
      const result = loadWorkspaceAuditConfig(fsFactory(chestnutRoot));
      expect(result.kind).toBe('invalid');
    });

    it('schema 校验失败（schema_version 错 / max_size_mb 非数）→ invalid', () => {
      fs.mkdirSync(path.join(chestnutRoot, AUDIT_PATHS.root), { recursive: true });
      fs.writeFileSync(
        path.join(chestnutRoot, AUDIT_PATHS.config),
        'schema_version: 2\nretention:\n  max_size_mb: null\n',
      );
      expect(loadWorkspaceAuditConfig(fsFactory(chestnutRoot)).kind).toBe('invalid');
      fs.writeFileSync(
        path.join(chestnutRoot, AUDIT_PATHS.config),
        'schema_version: 1\nretention:\n  max_size_mb: "a lot"\n',
      );
      expect(loadWorkspaceAuditConfig(fsFactory(chestnutRoot)).kind).toBe('invalid');
    });
  });

  describe('readWorkspaceAuditRetentionMaxSizeMb', () => {
    it('missing → null（旧 root schema default 行为等价）', () => {
      expect(readWorkspaceAuditRetentionMaxSizeMb(fsFactory(chestnutRoot))).toBeNull();
    });

    it('ok → 配置值', () => {
      publishMigratedWorkspaceAuditConfig(fsFactory(chestnutRoot), LEGACY_64, 'deadbeef');
      expect(readWorkspaceAuditRetentionMaxSizeMb(fsFactory(chestnutRoot))).toBe(64);
    });

    it('invalid → throw（fail-loud）', () => {
      fs.mkdirSync(path.join(chestnutRoot, AUDIT_PATHS.root), { recursive: true });
      fs.writeFileSync(path.join(chestnutRoot, AUDIT_PATHS.config), 'schema_version: 2\n');
      expect(() => readWorkspaceAuditRetentionMaxSizeMb(fsFactory(chestnutRoot))).toThrow(/Invalid workspace audit config/);
    });
  });

  describe('initWorkspaceAuditConfig', () => {
    it('fresh init 创建默认配置、磁盘形态与拍板一致', () => {
      expect(initWorkspaceAuditConfig(fsFactory(chestnutRoot))).toBe('created');
      expect(readConfigFile()).toBe('schema_version: 1\nretention:\n  max_size_mb: null\n');
    });

    it('已存在 → already，不覆盖现有内容', () => {
      publishMigratedWorkspaceAuditConfig(fsFactory(chestnutRoot), LEGACY_64, 'deadbeef');
      const before = readConfigFile();
      expect(initWorkspaceAuditConfig(fsFactory(chestnutRoot))).toBe('already');
      expect(readConfigFile()).toBe(before);
    });

    it('已存在但 invalid → throw，不静默抹掉', () => {
      fs.mkdirSync(path.join(chestnutRoot, AUDIT_PATHS.root), { recursive: true });
      fs.writeFileSync(path.join(chestnutRoot, AUDIT_PATHS.config), 'garbage: [');
      expect(() => initWorkspaceAuditConfig(fsFactory(chestnutRoot))).toThrow(/invalid/);
    });
  });

  describe('publishMigratedWorkspaceAuditConfig', () => {
    it('不存在 → published，写入 legacy 值并可读回', () => {
      expect(publishMigratedWorkspaceAuditConfig(fsFactory(chestnutRoot), LEGACY_64, 'deadbeef')).toBe('published');
      expect(readConfigFile()).toBe('schema_version: 1\nretention:\n  max_size_mb: 64\n');
      expect(loadWorkspaceAuditConfig(fsFactory(chestnutRoot))).toEqual({ kind: 'ok', config: LEGACY_64 });
    });

    it('已存在且同值 → already-present，文件不被重写', () => {
      publishMigratedWorkspaceAuditConfig(fsFactory(chestnutRoot), LEGACY_64, 'deadbeef');
      const before = readConfigFile();
      expect(publishMigratedWorkspaceAuditConfig(fsFactory(chestnutRoot), LEGACY_64, 'deadbeef')).toBe('already-present');
      expect(readConfigFile()).toBe(before);
    });

    it('已存在且异值 → ConflictError，双方保留（文件不被改写）', () => {
      publishMigratedWorkspaceAuditConfig(fsFactory(chestnutRoot), LEGACY_64, 'deadbeef');
      const before = readConfigFile();
      const attempt = () => publishMigratedWorkspaceAuditConfig(fsFactory(chestnutRoot), LEGACY_DEFAULT, 'cafe');
      expect(attempt).toThrow(AuditWorkspaceConfigConflictError);
      expect(attempt).toThrow(/Both preserved/);
      expect(readConfigFile()).toBe(before);
    });

    it('已存在但 invalid → throw', () => {
      fs.mkdirSync(path.join(chestnutRoot, AUDIT_PATHS.root), { recursive: true });
      fs.writeFileSync(path.join(chestnutRoot, AUDIT_PATHS.config), 'schema_version: 9\n');
      expect(() => publishMigratedWorkspaceAuditConfig(fsFactory(chestnutRoot), LEGACY_64, 'deadbeef')).toThrow(/invalid/);
    });
  });
});
