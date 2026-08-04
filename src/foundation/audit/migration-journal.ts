/**
 * @module L2a.AuditLog.MigrationJournal
 * @layer L2 基础层（AuditLog）
 *
 * Phase 1288 Step B: 迁移 journal（`.chestnut/audit/migrations/<id>/
 * {intent.json,outcome.json}`）与 `audit/layout.json` 的唯一 IO owner。
 *
 * 协议（由 CLIProcess 编排，本模块只提供原语、不编排）：
 *   intent → （AuditLog publish config + Assembly 移除 legacy 段）→ outcome → layout
 * 中断恢复语义：intent 存在而 outcome 不存在 = pending，可由
 * findPendingAuditMigration 发现并幂等续跑；outcome 存在 = 终态（含 conflict）。
 *
 * intent first-write-wins：同目录已有 intent 时重写是 no-op（不校验内容一致，
 * intent 是迁移起点的历史事实，resume 不推倒重来）。
 *
 * fs 一律以 chestnutRoot 为 baseDir；路径全部出自 ./layout.js。
 */
import type { FileSystem } from '../fs/index.js';
import { AUDIT_LAYOUT_SCHEMA_VERSION, AUDIT_PATHS } from './layout.js';
import type { AuditConfig } from './config-schema.js';

export interface AuditMigrationIntent {
  schema_version: number;
  migration_id: string;
  kind: 'audit-config-relocation';
  /** ISO 8601 创建时间（诊断用，不参与幂等判定）。 */
  created_at: string;
  source: {
    /** legacy 段所在文件（绝对路径，诊断用）。 */
    path: string;
    /** legacy 段顶层键名（AUDIT_LEGACY_PATHS.configSection）。 */
    section: string;
    /** legacy 段原文 canonical dump 的 sha256 hex。 */
    sha256: string;
  };
  legacy: AuditConfig;
}

export interface AuditMigrationOutcome {
  schema_version: number;
  migration_id: string;
  /**
   * completed: 新配置就位 + legacy 段已移除；
   * conflict:  双方值冲突、均保留（fail-loud 由编排层抛出）；
   * noop:      resume 时双方皆无、无事可做。
   */
  status: 'completed' | 'conflict' | 'noop';
  completed_at: string;
  /** 本次迁移是否实际写入了 audit/config.yaml（already-present/resume 为 false）。 */
  published: boolean;
  legacy_removed: boolean;
  detail?: string;
}

export interface AuditMigrationJournal {
  intent?: AuditMigrationIntent;
  outcome?: AuditMigrationOutcome;
}

function migrationDir(migrationId: string): string {
  return `${AUDIT_PATHS.migrations}/${migrationId}`;
}

/**
 * 写 intent（first-write-wins）：已存在 → no-op。
 * 写前确保内容含约定 schema_version / kind。
 */
export function writeAuditMigrationIntent(fs: FileSystem, intent: AuditMigrationIntent): void {
  const path = `${migrationDir(intent.migration_id)}/intent.json`;
  if (fs.existsSync(path)) return;
  fs.writeAtomicSync(path, `${JSON.stringify(intent, null, 2)}\n`);
}

/** 写 outcome（允许覆盖：conflict 重判 / resume 补写同态终态）。 */
export function writeAuditMigrationOutcome(fs: FileSystem, outcome: AuditMigrationOutcome): void {
  const path = `${migrationDir(outcome.migration_id)}/outcome.json`;
  fs.writeAtomicSync(path, `${JSON.stringify(outcome, null, 2)}\n`);
}

/** 读单个迁移 journal；文件存在但 JSON 损坏 → throw（不静默）。 */
export function readAuditMigrationJournal(fs: FileSystem, migrationId: string): AuditMigrationJournal {
  const dir = migrationDir(migrationId);
  const journal: AuditMigrationJournal = {};
  const intentPath = `${dir}/intent.json`;
  const outcomePath = `${dir}/outcome.json`;
  if (fs.existsSync(intentPath)) {
    journal.intent = JSON.parse(fs.readSync(intentPath)) as AuditMigrationIntent;
  }
  if (fs.existsSync(outcomePath)) {
    journal.outcome = JSON.parse(fs.readSync(outcomePath)) as AuditMigrationOutcome;
  }
  return journal;
}

/**
 * 发现 pending 迁移（intent 存在、outcome 缺失）。
 * migrations 目录不存在 → undefined。多个 pending 时按目录名字典序取首个
 * （正常协议下一刻至多一个 pending；多 pending 只可能来自手工干预）。
 */
export function findPendingAuditMigration(
  fs: FileSystem,
): { migrationId: string; intent: AuditMigrationIntent } | undefined {
  if (!fs.existsSync(AUDIT_PATHS.migrations)) return undefined;
  const entries = fs
    .listSync(AUDIT_PATHS.migrations, { includeDirs: true })
    .filter((e) => e.isDirectory)
    .map((e) => e.name)
    .sort();
  for (const name of entries) {
    const journal = readAuditMigrationJournal(fs, name);
    if (journal.intent && !journal.outcome) {
      return { migrationId: name, intent: journal.intent };
    }
  }
  return undefined;
}

/**
 * 发布 layout.json（迁移终态 / fresh init 时由编排层调用）。
 * 内容是布局协议版本 + owner 声明；路径 identity 的 SoT 是 ./layout.ts 常量，
 * 本文件只做磁盘留痕、不被生产代码读回。
 */
export function publishAuditLayout(fs: FileSystem): void {
  const layout = {
    schema_version: AUDIT_LAYOUT_SCHEMA_VERSION,
    owner: 'audit-log',
    updated_at: new Date().toISOString(),
  };
  fs.writeAtomicSync(AUDIT_PATHS.layout, `${JSON.stringify(layout, null, 2)}\n`);
}
