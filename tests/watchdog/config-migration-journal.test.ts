/**
 * Phase 1289 Step B: Watchdog 迁移 journal（watchdog/migrations/<id>/{intent,outcome}.json）
 * 与 layout.json 发布原语。
 *
 * 覆盖：intent first-write-wins / outcome 覆写 / journal 读取（含 retired_fields
 * roundtrip）/ pending 发现（无目录、仅 intent、intent+outcome、多目录字典序）/
 * publishWatchdogLayout 磁盘形态。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { WATCHDOG_LAYOUT_SCHEMA_VERSION, WATCHDOG_PATHS } from '../../src/watchdog/layout.js';
import {
  writeWatchdogMigrationIntent,
  writeWatchdogMigrationOutcome,
  readWatchdogMigrationJournal,
  findPendingWatchdogMigration,
  publishWatchdogLayout,
  type WatchdogMigrationIntent,
  type WatchdogMigrationOutcome,
} from '../../src/watchdog/config-migration-journal.js';
import { createTrackedTempDirSync } from '../utils/temp.js';

const fsFactory = (baseDir: string) => new NodeFileSystem({ baseDir });

function makeIntent(id: string): WatchdogMigrationIntent {
  return {
    schema_version: WATCHDOG_LAYOUT_SCHEMA_VERSION,
    migration_id: id,
    kind: 'watchdog-config-relocation',
    created_at: new Date().toISOString(),
    source: { path: '/ws/.chestnut/config.yaml', section: 'watchdog', sha256: 'a'.repeat(64) },
    legacy: { interval_ms: 60000, disk_warning_mb: 1024 },
  };
}

function makeOutcome(id: string, status: WatchdogMigrationOutcome['status'] = 'completed'): WatchdogMigrationOutcome {
  return {
    schema_version: WATCHDOG_LAYOUT_SCHEMA_VERSION,
    migration_id: id,
    status,
    completed_at: new Date().toISOString(),
    published: true,
    legacy_removed: true,
  };
}

describe('phase 1289 Step B: watchdog migration journal', () => {
  let chestnutRoot: string;

  beforeEach(() => {
    chestnutRoot = createTrackedTempDirSync('watchdog-journal-');
  });

  afterEach(() => {
    fs.rmSync(chestnutRoot, { recursive: true, force: true });
  });

  it('intent/outcome 写入 + 读回 roundtrip', () => {
    const rootFs = fsFactory(chestnutRoot);
    writeWatchdogMigrationIntent(rootFs, makeIntent('m1'));
    writeWatchdogMigrationOutcome(rootFs, makeOutcome('m1'));
    const journal = readWatchdogMigrationJournal(rootFs, 'm1');
    expect(journal.intent?.migration_id).toBe('m1');
    expect(journal.intent?.legacy).toEqual({ interval_ms: 60000, disk_warning_mb: 1024 });
    expect(journal.outcome?.status).toBe('completed');
    // 嵌套目录自动创建
    expect(fs.existsSync(path.join(chestnutRoot, WATCHDOG_PATHS.migrations, 'm1', 'intent.json'))).toBe(true);
  });

  it('retired_fields（log_archive_days 显式退役留证）roundtrip', () => {
    const rootFs = fsFactory(chestnutRoot);
    writeWatchdogMigrationIntent(rootFs, { ...makeIntent('m1'), retired_fields: { log_archive_days: 30 } });
    const journal = readWatchdogMigrationJournal(rootFs, 'm1');
    expect(journal.intent?.retired_fields).toEqual({ log_archive_days: 30 });
    // 无退役字段的 intent 不携带该键
    writeWatchdogMigrationIntent(rootFs, makeIntent('m2'));
    expect(readWatchdogMigrationJournal(rootFs, 'm2').intent?.retired_fields).toBeUndefined();
  });

  it('intent first-write-wins：重写是 no-op（保留首个 created_at）', () => {
    const rootFs = fsFactory(chestnutRoot);
    const first = makeIntent('m1');
    writeWatchdogMigrationIntent(rootFs, first);
    const second = { ...makeIntent('m1'), created_at: '1999-01-01T00:00:00.000Z' };
    writeWatchdogMigrationIntent(rootFs, second);
    expect(readWatchdogMigrationJournal(rootFs, 'm1').intent?.created_at).toBe(first.created_at);
  });

  it('outcome 允许覆写（conflict 重判 / resume 补写）', () => {
    const rootFs = fsFactory(chestnutRoot);
    writeWatchdogMigrationOutcome(rootFs, makeOutcome('m1', 'conflict'));
    writeWatchdogMigrationOutcome(rootFs, makeOutcome('m1', 'completed'));
    expect(readWatchdogMigrationJournal(rootFs, 'm1').outcome?.status).toBe('completed');
  });

  it('findPendingWatchdogMigration：无 migrations 目录 → undefined', () => {
    expect(findPendingWatchdogMigration(fsFactory(chestnutRoot))).toBeUndefined();
  });

  it('findPendingWatchdogMigration：仅 intent → pending；补 outcome 后 → undefined（终态）', () => {
    const rootFs = fsFactory(chestnutRoot);
    writeWatchdogMigrationIntent(rootFs, makeIntent('m1'));
    const pending = findPendingWatchdogMigration(rootFs);
    expect(pending?.migrationId).toBe('m1');
    expect(pending?.intent.legacy).toEqual({ interval_ms: 60000, disk_warning_mb: 1024 });
    writeWatchdogMigrationOutcome(rootFs, makeOutcome('m1'));
    expect(findPendingWatchdogMigration(rootFs)).toBeUndefined();
  });

  it('findPendingWatchdogMigration：多个迁移目录时只挑 intent-only 的（字典序首个）', () => {
    const rootFs = fsFactory(chestnutRoot);
    writeWatchdogMigrationIntent(rootFs, makeIntent('aaa-done'));
    writeWatchdogMigrationOutcome(rootFs, makeOutcome('aaa-done'));
    writeWatchdogMigrationIntent(rootFs, makeIntent('bbb-pending'));
    expect(findPendingWatchdogMigration(rootFs)?.migrationId).toBe('bbb-pending');
  });

  it('publishWatchdogLayout 写 layout.json：schema_version + owner', () => {
    const rootFs = fsFactory(chestnutRoot);
    publishWatchdogLayout(rootFs);
    const layout = JSON.parse(fs.readFileSync(path.join(chestnutRoot, WATCHDOG_PATHS.layout), 'utf8'));
    expect(layout.schema_version).toBe(WATCHDOG_LAYOUT_SCHEMA_VERSION);
    expect(layout.owner).toBe('watchdog');
    expect(typeof layout.updated_at).toBe('string');
  });
});
