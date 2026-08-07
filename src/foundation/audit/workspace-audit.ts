/**
 * @module L2a.AuditLog.WorkspaceAudit
 * @layer L2 基础层（AuditLog）
 *
 * Phase 1288 Step C + Phase 1318 Step B: workspace 根审计 capability —
 * `.chestnut/audit/audit.tsv` 与 `.chestnut/audit/tick.tsv`。
 * Watchdog daemon / CLI 侧 Watchdog 操作统一经此。
 *
 * 设计契约（Phase 1288 总览拍板 + phase 1318 心跳路由）：
 * - caller 只给 fsFactory + chestnutRoot；不得传路径、maxSizeMb 或 raw config；
 * - 目标路径固定 AUDIT_PATHS.audit（audit/audit.tsv，相对 chestnutRoot）；
 * - 心跳类事件由调用方通过 routing 参数注入，分发到 audit/tick.tsv（30 天滚动）；
 *   foundation 不 import 任何业务模块（mirror daemon-entry auditFileRouting 先例）。
 * - retention 自 AuditLog 自家 config store 读取（missing → null；invalid → throw）。
 *
 * legacy 根 audit.tsv 本模块不读不写；
 * 兼容期双段读取归 workspace-segments.ts（Step D）、monitor 校准归
 * jobs/audit-size-monitor.ts（Step D 收口三段常驻观察）。
 */
import * as path from 'node:path';
import type { FileSystem } from '../fs/index.js';
import type { AuditLog, AuditFileName } from './types.js';
import { createSystemAudit } from './factory.js';
import { AUDIT_PATHS } from './layout.js';
import { readWorkspaceAuditRetentionMaxSizeMb } from './workspace-config.js';


/**
 * 构造 workspace 根审计 writer（固定写 `audit/audit.tsv`，心跳事件 → `audit/tick.tsv`）。
 * invalid config → throw（fail-loud，与 readWorkspaceAuditRetentionMaxSizeMb 契约一致）。
 */
export function createWorkspaceAudit(
  fsFactory: (baseDir: string) => FileSystem,
  chestnutRoot: string,
  routing?: Readonly<Record<string, AuditFileName>>,
): AuditLog {
  const fs = fsFactory(chestnutRoot);
  const maxSizeMb = readWorkspaceAuditRetentionMaxSizeMb(fs);
  const typeToFile = new Map<string, AuditFileName>(Object.entries(routing ?? {}));
  return createSystemAudit(fs, path.dirname(AUDIT_PATHS.audit), {
    typeToFile,
    maxSizeMb,
  });
}
