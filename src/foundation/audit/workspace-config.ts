/**
 * @module L2a.AuditLog.WorkspaceConfig
 * @layer L2 基础层（AuditLog）
 *
 * Phase 1288 Step B: AuditLog 自家 config store — `.chestnut/audit/config.yaml`
 * 的唯一 IO owner（retention 语义 SoT 自 root YAML 迁回 AuditLog）。
 *
 * API 分三类：
 * - 读：loadWorkspaceAuditConfig（typed discriminated result：ok / missing /
 *   invalid，绝不静默创建）；readWorkspaceAuditRetentionMaxSizeMb（消费方便捷
 *   读取，missing → null 与旧 schema default 行为等价，invalid → throw fail-loud）。
 * - 写（fresh init）：initWorkspaceAuditConfig 创建默认配置 + 回读校验；
 *   已存在不覆盖。
 * - 写（迁移）：publishMigratedWorkspaceAuditConfig — exclusive publish + 回读
 *   校验；只接 typed legacy AuditConfig 及 source hash，不接完整 GlobalConfig；
 *   已有同值配置 → already-present（幂等），已有异值配置 → conflict fail-loud。
 *
 * fs 一律以 chestnutRoot 为 baseDir；路径全部出自 ./layout.js。
 */
import * as yaml from 'js-yaml';
import type { FileSystem } from '../fs/index.js';
import { formatErr } from '../node-utils/index.js';
import { AUDIT_LAYOUT_SCHEMA_VERSION, AUDIT_PATHS } from './layout.js';
import {
  auditWorkspaceConfigFileSchema,
  createDefaultAuditWorkspaceConfig,
  type AuditConfig,
} from './config-schema.js';

export type WorkspaceAuditConfigResult =
  | { kind: 'ok'; config: AuditConfig }
  | { kind: 'missing' }
  | { kind: 'invalid'; message: string };

/** 双方 retention 值不一致时抛出（fail-loud；双方文件均保留、由 caller 处理）。 */
export class AuditWorkspaceConfigConflictError extends Error {
  constructor(
    message: string,
    readonly existing: AuditConfig,
    readonly incoming: AuditConfig,
    readonly sourceHash: string,
  ) {
    super(message);
    this.name = 'AuditWorkspaceConfigConflictError';
  }
}

function sameAuditConfig(a: AuditConfig, b: AuditConfig): boolean {
  return a.retention.max_size_mb === b.retention.max_size_mb;
}

/** 序列化为拍板磁盘形态（schema_version 在前、key 顺序固定）。 */
function serializeWorkspaceAuditConfig(config: AuditConfig): string {
  return yaml.dump({
    schema_version: AUDIT_LAYOUT_SCHEMA_VERSION,
    retention: { max_size_mb: config.retention.max_size_mb },
  });
}

/**
 * 读取 workspace audit config。不创建、不改写任何文件。
 * invalid 覆盖：读失败 / YAML 语法错 / schema 校验失败。
 */
export function loadWorkspaceAuditConfig(fs: FileSystem): WorkspaceAuditConfigResult {
  if (!fs.existsSync(AUDIT_PATHS.config)) {
    return { kind: 'missing' };
  }
  let raw: string;
  try {
    raw = fs.readSync(AUDIT_PATHS.config);
  } catch (err) {
    return { kind: 'invalid', message: `read failed: ${formatErr(err)}` };
  }
  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    return { kind: 'invalid', message: `invalid YAML: ${formatErr(err)}` };
  }
  const result = auditWorkspaceConfigFileSchema.safeParse(parsed);
  if (!result.success) {
    return { kind: 'invalid', message: `schema validation failed: ${formatErr(result.error)}` };
  }
  return { kind: 'ok', config: { retention: result.data.retention } };
}

/**
 * 消费方便捷读取 retention.max_size_mb。
 * ok → 配置值；missing → null（与旧 root schema default 行为等价）；invalid → throw。
 */
export function readWorkspaceAuditRetentionMaxSizeMb(fs: FileSystem): number | null {
  const result = loadWorkspaceAuditConfig(fs);
  if (result.kind === 'missing') return null;
  if (result.kind === 'invalid') {
    throw new Error(`Invalid workspace audit config (${AUDIT_PATHS.config}): ${result.message}`);
  }
  return result.config.retention.max_size_mb;
}

/** 写文件 + 回读校验（publish/create 共用）。 */
function writeAndVerify(fs: FileSystem, config: AuditConfig, context: string): void {
  fs.writeAtomicSync(AUDIT_PATHS.config, serializeWorkspaceAuditConfig(config));
  const readback = loadWorkspaceAuditConfig(fs);
  if (readback.kind !== 'ok' || !sameAuditConfig(readback.config, config)) {
    throw new Error(
      `Audit config ${context} readback verification failed (${AUDIT_PATHS.config}): ` +
      (readback.kind === 'ok'
        ? `expected max_size_mb=${config.retention.max_size_mb}, got ${readback.config.retention.max_size_mb}`
        : `${readback.kind}${readback.kind === 'invalid' ? `: ${readback.message}` : ''}`),
    );
  }
}

/**
 * Fresh init 专用：创建默认配置。已存在合法配置 → 'already'（不覆盖）；
 * 已存在但 invalid → throw（不静默抹掉用户/损坏文件）。
 */
export function initWorkspaceAuditConfig(fs: FileSystem): 'created' | 'already' {
  const existing = loadWorkspaceAuditConfig(fs);
  if (existing.kind === 'ok') return 'already';
  if (existing.kind === 'invalid') {
    throw new Error(
      `Cannot init workspace audit config: existing ${AUDIT_PATHS.config} is invalid: ${existing.message}`,
    );
  }
  writeAndVerify(fs, createDefaultAuditWorkspaceConfig(), 'init');
  return 'created';
}

/**
 * 迁移专用 exclusive publish（Phase 1288 Step B 契约步骤 3）。
 *
 * - 不存在 → 写入 legacy 值 + 回读校验 → 'published'；
 * - 已存在且同值 → 'already-present'（幂等重入，不重写）；
 * - 已存在且异值 → AuditWorkspaceConfigConflictError（保留双方、fail-loud）；
 * - 已存在但 invalid → throw。
 *
 * sourceHash 仅用于诊断信息（journal intent 由 CLIProcess 另行写入）。
 */
export function publishMigratedWorkspaceAuditConfig(
  fs: FileSystem,
  legacy: AuditConfig,
  sourceHash: string,
): 'published' | 'already-present' {
  const existing = loadWorkspaceAuditConfig(fs);
  if (existing.kind === 'invalid') {
    throw new Error(
      `Cannot publish migrated audit config: existing ${AUDIT_PATHS.config} is invalid: ${existing.message}`,
    );
  }
  if (existing.kind === 'ok') {
    if (sameAuditConfig(existing.config, legacy)) return 'already-present';
    throw new AuditWorkspaceConfigConflictError(
      `Audit config conflict: ${AUDIT_PATHS.config} already exists with different value ` +
      `(existing max_size_mb=${existing.config.retention.max_size_mb}, ` +
      `legacy max_size_mb=${legacy.retention.max_size_mb}, source sha256=${sourceHash}). ` +
      `Both preserved; resolve manually.`,
      existing.config,
      legacy,
      sourceHash,
    );
  }
  writeAndVerify(fs, legacy, 'publish');
  return 'published';
}
