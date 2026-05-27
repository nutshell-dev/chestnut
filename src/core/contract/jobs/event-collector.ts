import * as path from 'path';
import { isFileNotFound, type FileSystem } from '../../../foundation/fs/types.js';
import type { AuditLog } from '../../../foundation/audit/index.js';
import type { ProgressData } from '../manager.js';
import { CONTRACT_AUDIT_EVENTS } from '../audit-events.js';
import { CONTRACT_DIR } from '../dirs.js';
import type { ClawId } from '../../../foundation/identity/index.js';
import { type ClawDir } from '../../../foundation/identity/index.js';


export function collectContractEvents(
  fs: FileSystem,
  clawDir: ClawDir,
  clawId: ClawId,
  sinceTs: number,
  audit: AuditLog,
): string[] {
  const events: string[] = [];

  // 1. archive 中新完成
  const archiveDir = path.join(clawDir, CONTRACT_DIR, 'archive');
  try {
    const dirs = fs.listSync(archiveDir, { includeDirs: true })
      .filter(e => e.isDirectory);
    for (const d of dirs) {
      const progressPath = path.join(archiveDir, d.name, 'progress.json');
      try {
        const raw = fs.readSync(progressPath);
        const parsed = JSON.parse(raw) as { contract_id?: unknown; status?: unknown; subtasks?: unknown };
        if (
          typeof parsed.contract_id !== 'string' ||
          typeof parsed.status !== 'string' ||
          typeof parsed.subtasks !== 'object' || parsed.subtasks === null
        ) {
          audit?.write(
            CONTRACT_AUDIT_EVENTS.PROGRESS_SCHEMA_INVALID,
            `clawId=${clawId}`,
            `contract=${d.name}`,
            `context=event_collector_archive`,
          );
          continue;
        }
        const progress = parsed as ProgressData;
        const completedAfter = Object.values(progress.subtasks)
          .some(s => s.completed_at && new Date(s.completed_at).getTime() > sinceTs);
        if (completedAfter && progress.status === 'completed') {
          events.push(`[contract_completed] claw=${clawId} contract=${d.name}`);
        }
      } catch (err) {
        // phase 1154 r+ derive: ENOENT-equivalent = progress.json absent (archive 常态 + active 升级 race)、非 corruption 语义
        // phase 587 ⚓ invariant: PROGRESS_CORRUPTED 仅用真 JSON.parse 失败 / schema_invalid 已独立 const
        if (isFileNotFound(err)) {
          continue; // silent skip absent / 不入 audit
        }
        audit?.write(
          CONTRACT_AUDIT_EVENTS.PROGRESS_CORRUPTED,
          `clawId=${clawId}`,
          `contract=${d.name}`,
          `context=event_collector_archive`,
          `error=${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
    }
  } catch (err) {
    // phase 1154 r+ derive: 双码 narrow via foundation helper (FileSystem 抽象层抛 FS_NOT_FOUND)
    if (!isFileNotFound(err)) {
      const code = (err as NodeJS.ErrnoException)?.code;
      audit?.write(
        CONTRACT_AUDIT_EVENTS.EVENT_COLLECTOR_SCAN_FAILED,
        `dir=archive`,
        `code=${code ?? 'unknown'}`,
        `error=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 2. active 中升级事件
  const activeDir = path.join(clawDir, CONTRACT_DIR, 'active');
  try {
    const dirs = fs.listSync(activeDir, { includeDirs: true })
      .filter(e => e.isDirectory);
    for (const d of dirs) {
      const progressPath = path.join(activeDir, d.name, 'progress.json');
      try {
        const raw = fs.readSync(progressPath);
        const parsed = JSON.parse(raw) as { contract_id?: unknown; status?: unknown; subtasks?: unknown };
        if (
          typeof parsed.contract_id !== 'string' ||
          typeof parsed.status !== 'string' ||
          typeof parsed.subtasks !== 'object' || parsed.subtasks === null
        ) {
          audit?.write(
            CONTRACT_AUDIT_EVENTS.PROGRESS_SCHEMA_INVALID,
            `clawId=${clawId}`,
            `contract=${d.name}`,
            `context=event_collector_active`,
          );
          continue;
        }
        const progress = parsed as ProgressData;
        for (const [stId, st] of Object.entries(progress.subtasks)) {
          if (st.escalated_at && new Date(st.escalated_at).getTime() > sinceTs) {
            events.push(`[contract_escalation] claw=${clawId} contract=${d.name} subtask=${stId} retry_count=${st.retry_count}`);
          }
        }
      } catch (err) {
        // phase 1154 r+ derive: ENOENT-equivalent = progress.json absent (active 升级 race)、非 corruption 语义
        if (isFileNotFound(err)) {
          continue; // silent skip absent / 不入 audit
        }
        audit?.write(
          CONTRACT_AUDIT_EVENTS.PROGRESS_CORRUPTED,
          `clawId=${clawId}`,
          `contract=${d.name}`,
          `context=event_collector_active`,
          `error=${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
    }
  } catch (err) {
    // phase 1154 r+ derive: 双码 narrow via foundation helper (FileSystem 抽象层抛 FS_NOT_FOUND)
    if (!isFileNotFound(err)) {
      const code = (err as NodeJS.ErrnoException)?.code;
      audit?.write(
        CONTRACT_AUDIT_EVENTS.EVENT_COLLECTOR_SCAN_FAILED,
        `dir=active`,
        `code=${code ?? 'unknown'}`,
        `error=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return events;
}
