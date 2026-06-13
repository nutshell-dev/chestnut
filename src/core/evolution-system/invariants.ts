// src/core/evolution-system/invariants.ts

/**
 * evolution-system state.json save 入口 schema invariant。
 *
 * 应然 anchor（per design/modules/l4_evolution_system.md §「persist-state observability」、phase 253 Step A + phase 280）:
 * - DP1 信息不丢失：state.json 是 evolution 累进权威进度
 * - DP2 不静默丢弃：违例 emit audit 消除静默
 * - DP3/DP5 状态可观察 + 凭日志记录重建：违例显式可观察
 *
 * 与 `_loadState` load 端 check 对称：load 端违例 `_backupCorruptState` isolate + emit STATE_LOAD_FAILED、
 * save 端只 emit invariant_violated audit、不 isolate 文件（Path #4 防 break _saveState 业务路径）。
 *
 * phase 280: 高水位线改造后 schema：
 * - version: number === 1 (current schema_version)
 * - lastProcessedAt: number (ms epoch, finite, non-negative)
 *
 * 不 throw（DP1 + Path #4 防 break _saveState 路径）。
 */

import type { AuditLog } from '../../foundation/audit/index.js';
import { RETRO_AUDIT_EVENTS } from './retro-audit-events.js';

/**
 * Evolution state schema 当前版本号.
 * Derivation: 1 = 首版 schema、未有迁移 / 改 schema 时同步 system.ts 字面量 +
 * 同步 PROGRESS_CURRENT_SCHEMA_VERSION 类（业务初版 schema 均 1）.
 * 升级时 read 路径用版本号区分 migration.
 */
const EVOLUTION_STATE_CURRENT_VERSION = 1;

export function assertEvolutionStateShape(state: unknown, audit: AuditLog): void {
  if (typeof state !== 'object' || state === null) {
    audit.write(
      RETRO_AUDIT_EVENTS.EVOLUTION_STATE_INVARIANT_VIOLATED,
      `kind=state_not_object`, `actual=${typeof state}`,
    );
    return;
  }
  const s = state as Record<string, unknown>;

  checkVersion(s, audit);
  checkLastProcessedAt(s, audit);
}

function checkVersion(s: Record<string, unknown>, audit: AuditLog): void {
  if (typeof s.version !== 'number') {
    audit.write(
      RETRO_AUDIT_EVENTS.EVOLUTION_STATE_INVARIANT_VIOLATED,
      `kind=version_not_number`, `actual=${typeof s.version}`,
    );
  } else if (s.version !== EVOLUTION_STATE_CURRENT_VERSION) {
    audit.write(
      RETRO_AUDIT_EVENTS.EVOLUTION_STATE_INVARIANT_VIOLATED,
      `kind=version_mismatch`, `actual=${s.version}`, `expected=${EVOLUTION_STATE_CURRENT_VERSION}`,
    );
  }
}

function checkLastProcessedAt(s: Record<string, unknown>, audit: AuditLog): void {
  if (typeof s.lastProcessedAt !== 'number'
      || !Number.isFinite(s.lastProcessedAt)
      || s.lastProcessedAt < 0) {
    audit.write(
      RETRO_AUDIT_EVENTS.EVOLUTION_STATE_INVARIANT_VIOLATED,
      `kind=lastProcessedAt_invalid`, `actual=${String(s.lastProcessedAt)}`,
    );
  }
}
