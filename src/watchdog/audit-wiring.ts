import { createWorkspaceAudit, type AuditLog } from '../foundation/audit/index.js';
import type { FileSystem } from '../foundation/fs/index.js';
import { getChestnutDir, getAuditWriter, setAuditWriter } from './watchdog-context.js';
import { WATCHDOG_FILE_ROUTING } from './audit-events.js';

/**
 * CLI action 级窄审计能力（Phase 1878 Step I：audit wiring 归位）。
 *
 * 生命周期归属：
 * - watchdog daemon 进程：runWatchdogLoop 构造 + 安装、全终态 dispose（ownership
 *   loser/foreign/failed 早退 + entry 尾 + crash handler）——进程 own，不经本能力。
 * - CLI action：经本能力取得 writer；返回 handle 的 dispose 必须由调用方终态
 *   路径消费（CLI wrapper 内经 CliActionScope 注册 / 无 scope 时调用点 finally），
 *   旧 ensureAuditWired「lazy 安装后悬挂、永不 dispose」语义退役。
 *
 * 已安装语义（daemon 进程或前序 action 已安装）：返回非 owner handle——audit
 * 指向既有 writer、dispose 为 no-op（不抢生命周期）。
 *
 * 构造失败 fail-soft：console.error + audit=null，不阻断 action。
 *
 * Phase 1288 Step C: 构造委托 AuditLog 自家 createWorkspaceAudit（固定写
 * audit/audit.tsv、retention 自 AuditLog config store 自读）；Watchdog 不再
 * 接触路径 / maxSizeMb / Assembly config。
 */
export interface WatchdogActionAudit {
  /** 本 action 可用的 writer（构造失败为 null，写入软降级）。 */
  readonly audit: AuditLog | null;
  /** 幂等：owner 情形释放 writer 并卸载 context 安装；非 owner no-op。 */
  dispose(): void;
}

export function createWatchdogActionAudit(
  fsFactory: (baseDir: string) => FileSystem,
): WatchdogActionAudit {
  const existing = getAuditWriter();
  if (existing !== null) {
    // 已安装（daemon 进程 own / 前序 action 安装）：非 owner，dispose 不动
    return { audit: existing, dispose(): void { /* no-op */ } };
  }
  let audit: AuditLog | null = null;
  try {
    audit = createWorkspaceAudit(fsFactory, getChestnutDir(), WATCHDOG_FILE_ROUTING);
  } catch (err) {
    console.error('Failed to wire watchdog audit in CLI:', err);
  }
  setAuditWriter(audit);
  let disposed = false;
  return {
    audit,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      try {
        audit?.dispose?.();
      } finally {
        // 仅卸载自家安装（防 dispose 时安装已被他人覆盖而清错对象）
        if (getAuditWriter() === audit) setAuditWriter(null);
      }
    },
  };
}
