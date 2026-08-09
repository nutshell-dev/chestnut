import { formatErr } from "../../node-utils/index.js";
/**
 * @module L2a.AuditLog.AuditSizeMonitor
 * @layer L2a
 * @depends L1.FileSystem, L2a.AuditLog
 *
 * AuditLog-owned monitor: 周期 stat motion/audit.tsv + 根级新旧两段
 * （audit/audit.tsv + legacy audit.tsv）大小、超阈值 emit audit + viewport stream notify (phase 8).
 *
 * Phase 1288 Step D 收口：三段常驻可观察（legacyAuditPath 必填）——兼容期旧版本
 * writer 可能仍写 legacy 根文件，两段共同构成完整历史，缺段（FNF）合法跳过、
 * 非 FNF stat 失败逐段 CHECK_FAILED 分型、不静默丢段。
 *
 * 阈值语义（phase 8 reframe）：informational only / 供开发者参考 / 无 motion action / 直接 viewport 显示提醒.
 *
 * phase 1154 derive (user 2026-05-23 Terminal SIGABRT 诊断追溯).
 * phase 8 reframe: motion inbox → viewport stream / dedup transition / 英文 self-contained.
 * phase 697 Step B: 物理迁 src/foundation/cron/jobs/ → src/foundation/audit/jobs/
 *   归属应然 = audit module sister 内 job (监控 audit file 自家 ephemeral 资源、M#1+M#3).
 *   @module L5.Cron.AuditSizeMonitor → L2a.AuditLog.AuditSizeMonitor.
 */

import { isFileNotFound } from '../../fs/index.js';
import type { FileSystem } from '../../fs/index.js';
import type { AuditLog } from '../types.js';
type NotifySink = { write(event: Record<string, unknown>): void };
import { AUDIT_SIZE_MONITOR_AUDIT_EVENTS } from './audit-size-monitor-audit-events.js';

/**
 * Cron job timeout (ms) / 防 stuck handler 占 cron tick.
 * 由本 module 业务自决 (per M#2 模块为自己业务语义负责).
 */
export const AUDIT_SIZE_MONITOR_CRON_TIMEOUT_MS = 30_000;

/**
 * audit.tsv size warning threshold（500 MB）.
 * Derivation: 500 * 1024 * 1024 = 524_288_000 byte / ≈ 5 周满载 audit 累积 /
 * 配 AUDIT_SIZE_CRITICAL_BYTES (1 GB) 形成 warn→critical 二级告警.
 */
const AUDIT_SIZE_WARN_BYTES = 500 * 1024 * 1024;

/**
 * audit.tsv size critical threshold（1 GB）.
 * Derivation: 1024 * 1024 * 1024 = 1_073_741_824 byte / ≈ 10 周满载 / 触发紧急 audit rotate /
 * 比 WARN 双倍因 disk 空间消耗速率约线性、双倍给运维窗口反应.
 */
const AUDIT_SIZE_CRITICAL_BYTES = 1024 * 1024 * 1024;

// phase 8: dedup per audit path / daemon process 生命周期内、under→over 时 emit / over→under 清状态允许下次再 fire
const auditOverThreshold = new Map<string, 'warn' | 'critical'>();

export interface AuditSizeMonitorOptions {
  fs: FileSystem;
  audit: AuditLog;
  primaryAuditPath: string;
  secondaryAuditPath: string;
  /**
   * Phase 1288 Step D 收口：legacy 根 audit.tsv（兼容期常驻观察，必填）。
   * 新写入只进新根路径（经 secondary 观察）；legacy 旧文件原样保留、
   * 只读观察其体量直到后续 Phase 有「无 legacy writer」磁盘证据后另行清退。
   */
  legacyAuditPath: string;
  warnBytes?: number;
  criticalBytes?: number;
  streamLog?: NotifySink;   // phase 8: motion streamWriter / 警告改 viewport system_notify 注入
  /** Stream-owned event discriminator, injected by the L6 composition root. */
  streamEventType?: string;
  signal?: AbortSignal;
}

export async function runAuditSizeMonitor(opts: AuditSizeMonitorOptions): Promise<void> {
  const warn = opts.warnBytes ?? AUDIT_SIZE_WARN_BYTES;
  const critical = opts.criticalBytes ?? AUDIT_SIZE_CRITICAL_BYTES;
  const paths = [opts.primaryAuditPath, opts.secondaryAuditPath, opts.legacyAuditPath];
  for (const p of paths) {
    if (opts.signal?.aborted) return;
    try {
      const stat = opts.fs.statSync(p);
      const size = stat.size;
      let level: 'warn' | 'critical' | null = null;
      if (size >= critical) level = 'critical';
      else if (size >= warn) level = 'warn';

      const prevLevel = auditOverThreshold.get(p) ?? null;
      if (level) {
        // phase 1322: audit.write 移入翻转分支（mirror streamLog dedup）——
        // 稳态超阈值 0 写入 audit.tsv（监控文件不再被监控自身写入、DP1 反噬消除）
        if (prevLevel !== level) {
          opts.audit.write(
            AUDIT_SIZE_MONITOR_AUDIT_EVENTS.THRESHOLD_EXCEEDED,
            `path=${p}`,
            `size_bytes=${size}`,
            `level=${level}`,
            `opt_in_hint=audit.retention.max_size_mb`,
          );
          const mb = Math.round(size / 1024 / 1024);
          if (opts.streamLog && opts.streamEventType) opts.streamLog.write({
            ts: Date.now(),
            type: opts.streamEventType,
            subtype: 'dev_warning',
            kind: 'audit_size',
            path: p,
            sizeMB: mb,
            level,
            // 语义：informational only / for developer reference / no action required
            message: `${p} size ${mb}MB reached ${level} threshold (set audit.retention.max_size_mb in config.yaml to enable rotation)`,
          });
          auditOverThreshold.set(p, level);
        }
      } else if (prevLevel !== null) {
        // 恢复（如 rotation / 清理后）→ 清状态、允许下次再 fire
        auditOverThreshold.delete(p);
      }
    } catch (err) {
      if (isFileNotFound(err)) continue; // 复用 α-1 helper
      opts.audit.write(
        AUDIT_SIZE_MONITOR_AUDIT_EVENTS.CHECK_FAILED,
        `path=${p}`,
        `code=${(err as NodeJS.ErrnoException)?.code ?? 'unknown'}`,
        `error=${formatErr(err)}`,
      );
    }
  }
}

/** Test-only: reset dedup state between cases. */
export function __resetAuditSizeMonitorState(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('__resetAuditSizeMonitorState is for tests only');
  }
  auditOverThreshold.clear();
}
