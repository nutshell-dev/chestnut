/**
 * Phase 1288 Step B: CLIProcess 迁移编排矩阵（ensureAuditConfigMigrated）。
 *
 * 矩阵：
 * - not-initialized（无 root config.yaml）→ 不动任何文件
 * - 仅 legacy → 全量迁移成功 + root YAML 其余字段语义不变 + intent/outcome/layout 齐备
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
import { ensureAuditConfigMigrated } from '../../src/cli/audit-config-migration.js';
import {
  loadWorkspaceAuditConfig,
  writeAuditMigrationIntent,
  publishMigratedWorkspaceAuditConfig,
  findPendingAuditMigration,
  AUDIT_LAYOUT_SCHEMA_VERSION,
  AUDIT_PATHS,
  type AuditConfig,
} from '../../src/foundation/audit/index.js';
import { readAuditMigrationJournal } from '../../src/foundation/audit/migration-journal.js';
import { createTrackedTempDirSync } from '../utils/temp.js';
import { createRootConfig, createRootConfigLegacyMigration } from '../../src/assembly/index.js';

const fsFactory = (baseDir: string) => new NodeFileSystem({ baseDir });
const deps = {
  fsFactory,
  rootConfig: createRootConfig({ fsFactory }),
  rootConfigLegacy: createRootConfigLegacyMigration({ fsFactory }),
};

const LEGACY_32: AuditConfig = { retention: { max_size_mb: 32 } };

function rootYamlWithAudit(maxSizeMb: number | null): string {
  return `version: '1'
custom_unknown_field: keep-me
llm:
  primary:
    preset: anthropic
    model: claude-sonnet-4-5
audit:
  retention:
    max_size_mb: ${maxSizeMb === null ? 'null' : maxSizeMb}
`;
}

const ROOT_YAML_NO_AUDIT = `version: '1'
custom_unknown_field: keep-me
`;

describe('phase 1288 Step B: audit config migration orchestration', () => {
  let workspaceRoot: string;
  let chestnutRoot: string;
  let configPath: string;

  beforeEach(() => {
    workspaceRoot = createTrackedTempDirSync('audit-migration-');
    chestnutRoot = path.join(workspaceRoot, '.chestnut');
    configPath = path.join(chestnutRoot, 'config.yaml');
    fs.mkdirSync(chestnutRoot, { recursive: true });
    vi.stubEnv('CHESTNUT_ROOT', workspaceRoot);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  function auditConfigOnDisk(): string | undefined {
    const p = path.join(chestnutRoot, AUDIT_PATHS.config);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : undefined;
  }

  it('not-initialized：无 root config.yaml → 不创建任何文件', () => {
    fs.rmSync(configPath, { force: true });
    expect(ensureAuditConfigMigrated(deps)).toEqual({ kind: 'not-initialized' });
    expect(fs.existsSync(path.join(chestnutRoot, AUDIT_PATHS.root))).toBe(false);
  });

  it('仅 legacy → migrated：新配置含 legacy 值、root YAML 其余字段语义不变、journal/layout 齐备', () => {
    fs.writeFileSync(configPath, rootYamlWithAudit(32));
    const result = ensureAuditConfigMigrated(deps);
    expect(result.kind).toBe('migrated');
    const migrationId = (result as { migrationId: string }).migrationId;

    // 新配置就位（typed 回读）
    expect(loadWorkspaceAuditConfig(fsFactory(chestnutRoot))).toEqual({ kind: 'ok', config: LEGACY_32 });
    expect(auditConfigOnDisk()).toBe('schema_version: 1\nretention:\n  max_size_mb: 32\n');

    // legacy 段移除 + root YAML 其余字段逐字节语义保持、无 default 注入
    const after = yaml.load(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    expect(after.audit).toBeUndefined();
    expect(after.custom_unknown_field).toBe('keep-me');
    expect(after.version).toBe('1');
    expect((after.llm as any).primary.model).toBe('claude-sonnet-4-5');
    expect(after.watchdog, 'no schema default injection').toBeUndefined();

    // intent + outcome(completed, published) + layout
    const journal = readAuditMigrationJournal(fsFactory(chestnutRoot), migrationId);
    expect(journal.intent?.kind).toBe('audit-config-relocation');
    expect(journal.intent?.legacy).toEqual(LEGACY_32);
    expect(journal.intent?.source.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(journal.outcome).toMatchObject({ status: 'completed', published: true, legacy_removed: true });
    expect(fs.existsSync(path.join(chestnutRoot, AUDIT_PATHS.layout))).toBe(true);
    expect(findPendingAuditMigration(fsFactory(chestnutRoot))).toBeUndefined();
  });

  it('仅新配置 → already，不产生 journal', () => {
    fs.writeFileSync(configPath, ROOT_YAML_NO_AUDIT);
    publishMigratedWorkspaceAuditConfig(fsFactory(chestnutRoot), LEGACY_32, 'x'.repeat(64));
    expect(ensureAuditConfigMigrated(deps)).toEqual({ kind: 'already' });
    expect(fs.existsSync(path.join(chestnutRoot, AUDIT_PATHS.migrations))).toBe(false);
  });

  it('两边同值 → migrated：删 legacy、新配置不重写（published=false）', () => {
    fs.writeFileSync(configPath, rootYamlWithAudit(32));
    publishMigratedWorkspaceAuditConfig(fsFactory(chestnutRoot), LEGACY_32, 'x'.repeat(64));
    const configBefore = auditConfigOnDisk();

    const result = ensureAuditConfigMigrated(deps);
    expect(result.kind).toBe('migrated');
    expect(auditConfigOnDisk()).toBe(configBefore);
    const after = yaml.load(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    expect(after.audit).toBeUndefined();
    const journal = readAuditMigrationJournal(fsFactory(chestnutRoot), (result as { migrationId: string }).migrationId);
    expect(journal.outcome).toMatchObject({ status: 'completed', published: false, legacy_removed: true });
  });

  it('两边冲突 → fail-loud 抛错、双方保留、journal 留 conflict outcome；重跑同 id 持久失败', () => {
    fs.writeFileSync(configPath, rootYamlWithAudit(32));
    publishMigratedWorkspaceAuditConfig(fsFactory(chestnutRoot), { retention: { max_size_mb: 64 } }, 'x'.repeat(64));
    const configBefore = auditConfigOnDisk();
    const rootBefore = fs.readFileSync(configPath, 'utf8');

    expect(() => ensureAuditConfigMigrated(deps)).toThrow(/Audit config conflict/);
    // 双方保留
    expect(auditConfigOnDisk()).toBe(configBefore);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(rootBefore);
    // journal 留证
    const rootFs = fsFactory(chestnutRoot);
    const entries = fs.readdirSync(path.join(chestnutRoot, AUDIT_PATHS.migrations));
    expect(entries).toHaveLength(1);
    const journal = readAuditMigrationJournal(rootFs, entries[0]);
    expect(journal.intent).toBeDefined();
    expect(journal.outcome?.status).toBe('conflict');

    // 重跑：同 migration id（content-derived）、持久 fail-loud、不产生第二个 journal 目录
    expect(() => ensureAuditConfigMigrated(deps)).toThrow(new RegExp(entries[0]));
    expect(fs.readdirSync(path.join(chestnutRoot, AUDIT_PATHS.migrations))).toHaveLength(1);
  });

  it('两边皆无 → missing：typed 报告、不静默创建', () => {
    fs.writeFileSync(configPath, ROOT_YAML_NO_AUDIT);
    expect(ensureAuditConfigMigrated(deps)).toEqual({ kind: 'missing' });
    expect(fs.existsSync(path.join(chestnutRoot, AUDIT_PATHS.root))).toBe(false);
  });

  it('新配置 invalid → fail-loud 抛错', () => {
    fs.writeFileSync(configPath, ROOT_YAML_NO_AUDIT);
    fs.mkdirSync(path.join(chestnutRoot, AUDIT_PATHS.root), { recursive: true });
    fs.writeFileSync(path.join(chestnutRoot, AUDIT_PATHS.config), 'schema_version: 2\n');
    expect(() => ensureAuditConfigMigrated(deps)).toThrow(/invalid/);
  });

  it('中断恢复：crash 于 publish 前（仅 intent + legacy）→ 同 id 续跑完成', () => {
    fs.writeFileSync(configPath, rootYamlWithAudit(32));
    const rootFs = fsFactory(chestnutRoot);
    writeAuditMigrationIntent(rootFs, {
      schema_version: AUDIT_LAYOUT_SCHEMA_VERSION,
      migration_id: 'crash-before-publish',
      kind: 'audit-config-relocation',
      created_at: new Date().toISOString(),
      source: { path: configPath, section: 'audit', sha256: 'f'.repeat(64) },
      legacy: LEGACY_32,
    });

    const result = ensureAuditConfigMigrated(deps);
    expect(result).toEqual({ kind: 'migrated', migrationId: 'crash-before-publish' });
    expect(loadWorkspaceAuditConfig(rootFs)).toEqual({ kind: 'ok', config: LEGACY_32 });
    expect((yaml.load(fs.readFileSync(configPath, 'utf8')) as any).audit).toBeUndefined();
    expect(readAuditMigrationJournal(rootFs, 'crash-before-publish').outcome?.status).toBe('completed');
  });

  it('中断恢复：crash 于删 legacy 前（intent + 新配置 + legacy 同值）→ 续跑删 legacy', () => {
    fs.writeFileSync(configPath, rootYamlWithAudit(32));
    const rootFs = fsFactory(chestnutRoot);
    writeAuditMigrationIntent(rootFs, {
      schema_version: AUDIT_LAYOUT_SCHEMA_VERSION,
      migration_id: 'crash-after-publish',
      kind: 'audit-config-relocation',
      created_at: new Date().toISOString(),
      source: { path: configPath, section: 'audit', sha256: 'f'.repeat(64) },
      legacy: LEGACY_32,
    });
    publishMigratedWorkspaceAuditConfig(rootFs, LEGACY_32, 'f'.repeat(64));

    const result = ensureAuditConfigMigrated(deps);
    expect(result).toEqual({ kind: 'migrated', migrationId: 'crash-after-publish' });
    expect((yaml.load(fs.readFileSync(configPath, 'utf8')) as any).audit).toBeUndefined();
    expect(readAuditMigrationJournal(rootFs, 'crash-after-publish').outcome).toMatchObject({
      status: 'completed', legacy_removed: true,
    });
  });

  it('中断恢复：crash 于 outcome 前（新配置在、legacy 已删、仅 intent）→ 补 outcome/layout 报 already', () => {
    fs.writeFileSync(configPath, ROOT_YAML_NO_AUDIT);
    const rootFs = fsFactory(chestnutRoot);
    writeAuditMigrationIntent(rootFs, {
      schema_version: AUDIT_LAYOUT_SCHEMA_VERSION,
      migration_id: 'crash-before-outcome',
      kind: 'audit-config-relocation',
      created_at: new Date().toISOString(),
      source: { path: configPath, section: 'audit', sha256: 'f'.repeat(64) },
      legacy: LEGACY_32,
    });
    publishMigratedWorkspaceAuditConfig(rootFs, LEGACY_32, 'f'.repeat(64));

    expect(ensureAuditConfigMigrated(deps)).toEqual({ kind: 'already' });
    expect(readAuditMigrationJournal(rootFs, 'crash-before-outcome').outcome?.status).toBe('completed');
    expect(fs.existsSync(path.join(chestnutRoot, AUDIT_PATHS.layout))).toBe(true);
    expect(findPendingAuditMigration(rootFs)).toBeUndefined();
  });

  it('幂等重入：迁移完成后第二次运行 → already、状态不变', () => {
    fs.writeFileSync(configPath, rootYamlWithAudit(32));
    const first = ensureAuditConfigMigrated(deps);
    expect(first.kind).toBe('migrated');
    const configAfterFirst = auditConfigOnDisk();
    const rootAfterFirst = fs.readFileSync(configPath, 'utf8');

    expect(ensureAuditConfigMigrated(deps)).toEqual({ kind: 'already' });
    expect(auditConfigOnDisk()).toBe(configAfterFirst);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(rootAfterFirst);
  });
});
