/**
 * Phase 1288 Step B: AuditLog 迁移 journal（audit/migrations/<id>/{intent,outcome}.json）
 * 与 layout.json 发布原语。
 *
 * 覆盖：intent first-write-wins / outcome 覆写 / journal 读取 / pending 发现
 * （无目录、仅 intent、intent+outcome、多目录字典序）/ publishAuditLayout 磁盘形态。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import {
  writeAuditMigrationIntent,
  writeAuditMigrationOutcome,
  readAuditMigrationJournal,
  findPendingAuditMigration,
  publishAuditLayout,
  AUDIT_LAYOUT_SCHEMA_VERSION,
  AUDIT_PATHS,
  type AuditMigrationIntent,
  type AuditMigrationOutcome,
} from '../../../src/foundation/audit/index.js';
import { createTrackedTempDirSync } from '../../utils/temp.js';

const fsFactory = (baseDir: string) => new NodeFileSystem({ baseDir });

function makeIntent(id: string): AuditMigrationIntent {
  return {
    schema_version: AUDIT_LAYOUT_SCHEMA_VERSION,
    migration_id: id,
    kind: 'audit-config-relocation',
    created_at: new Date().toISOString(),
    source: { path: '/ws/.chestnut/config.yaml', section: 'audit', sha256: 'a'.repeat(64) },
    legacy: { retention: { max_size_mb: 32 } },
  };
}

function makeOutcome(id: string, status: AuditMigrationOutcome['status'] = 'completed'): AuditMigrationOutcome {
  return {
    schema_version: AUDIT_LAYOUT_SCHEMA_VERSION,
    migration_id: id,
    status,
    completed_at: new Date().toISOString(),
    published: true,
    legacy_removed: true,
  };
}

describe('phase 1288 Step B: audit migration journal', () => {
  let chestnutRoot: string;

  beforeEach(() => {
    chestnutRoot = createTrackedTempDirSync('audit-journal-');
  });

  afterEach(() => {
    fs.rmSync(chestnutRoot, { recursive: true, force: true });
  });

  it('intent/outcome 写入 + 读回 roundtrip', () => {
    const rootFs = fsFactory(chestnutRoot);
    writeAuditMigrationIntent(rootFs, makeIntent('m1'));
    writeAuditMigrationOutcome(rootFs, makeOutcome('m1'));
    const journal = readAuditMigrationJournal(rootFs, 'm1');
    expect(journal.intent?.migration_id).toBe('m1');
    expect(journal.intent?.legacy).toEqual({ retention: { max_size_mb: 32 } });
    expect(journal.outcome?.status).toBe('completed');
    // 嵌套目录自动创建
    expect(fs.existsSync(path.join(chestnutRoot, AUDIT_PATHS.migrations, 'm1', 'intent.json'))).toBe(true);
  });

  it('intent first-write-wins：重写是 no-op（保留首个 created_at）', () => {
    const rootFs = fsFactory(chestnutRoot);
    const first = makeIntent('m1');
    writeAuditMigrationIntent(rootFs, first);
    const second = { ...makeIntent('m1'), created_at: '1999-01-01T00:00:00.000Z' };
    writeAuditMigrationIntent(rootFs, second);
    expect(readAuditMigrationJournal(rootFs, 'm1').intent?.created_at).toBe(first.created_at);
  });

  it('outcome 允许覆写（conflict 重判 / resume 补写）', () => {
    const rootFs = fsFactory(chestnutRoot);
    writeAuditMigrationOutcome(rootFs, makeOutcome('m1', 'conflict'));
    writeAuditMigrationOutcome(rootFs, makeOutcome('m1', 'completed'));
    expect(readAuditMigrationJournal(rootFs, 'm1').outcome?.status).toBe('completed');
  });

  it('findPendingAuditMigration：无 migrations 目录 → undefined', () => {
    expect(findPendingAuditMigration(fsFactory(chestnutRoot))).toBeUndefined();
  });

  it('findPendingAuditMigration：仅 intent → pending；补 outcome 后 → undefined（终态）', () => {
    const rootFs = fsFactory(chestnutRoot);
    writeAuditMigrationIntent(rootFs, makeIntent('m1'));
    const pending = findPendingAuditMigration(rootFs);
    expect(pending?.migrationId).toBe('m1');
    expect(pending?.intent.legacy).toEqual({ retention: { max_size_mb: 32 } });
    writeAuditMigrationOutcome(rootFs, makeOutcome('m1'));
    expect(findPendingAuditMigration(rootFs)).toBeUndefined();
  });

  it('findPendingAuditMigration：多个迁移目录时只挑 intent-only 的（字典序首个）', () => {
    const rootFs = fsFactory(chestnutRoot);
    writeAuditMigrationIntent(rootFs, makeIntent('aaa-done'));
    writeAuditMigrationOutcome(rootFs, makeOutcome('aaa-done'));
    writeAuditMigrationIntent(rootFs, makeIntent('bbb-pending'));
    expect(findPendingAuditMigration(rootFs)?.migrationId).toBe('bbb-pending');
  });

  it('publishAuditLayout 写 layout.json：schema_version + owner', () => {
    const rootFs = fsFactory(chestnutRoot);
    publishAuditLayout(rootFs);
    const layout = JSON.parse(fs.readFileSync(path.join(chestnutRoot, AUDIT_PATHS.layout), 'utf8'));
    expect(layout.schema_version).toBe(AUDIT_LAYOUT_SCHEMA_VERSION);
    expect(layout.owner).toBe('audit-log');
    expect(typeof layout.updated_at).toBe('string');
  });
});
