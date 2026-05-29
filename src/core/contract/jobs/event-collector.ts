import * as path from 'path';
import * as yaml from 'js-yaml';
import { isFileNotFound, type FileSystem } from '../../../foundation/fs/types.js';
import type { AuditLog } from '../../../foundation/audit/index.js';
import type { ProgressData } from '../manager.js';
import { CONTRACT_AUDIT_EVENTS } from '../audit-events.js';
import { CONTRACT_DIR } from '../dirs.js';
import type { ClawId } from '../../../foundation/identity/index.js';
import { type ClawDir } from '../../../foundation/identity/index.js';

function readContractMeta(
  fs: FileSystem,
  contractDir: string,
): { title?: string; goal?: string } {
  try {
    const raw = fs.readSync(path.join(contractDir, 'contract.yaml'));
    const parsed = yaml.load(raw) as { title?: unknown; goal?: unknown } | undefined;
    return {
      title: typeof parsed?.title === 'string' ? parsed.title : undefined,
      goal: typeof parsed?.goal === 'string' ? parsed.goal : undefined,
    };
  } catch {
    // silent: contract.yaml meta is decorative for event-collector; missing/corrupt yaml falls back to bare event (claw+contract still emitted)
    return {};
  }
}

function formatContractCompletedEvent(
  clawId: ClawId,
  contractDirName: string,
  meta: { title?: string; goal?: string },
  progress: ProgressData,
): string {
  const lines: string[] = [`[contract_completed] claw=${clawId} contract=${contractDirName}`];
  if (meta.title) lines.push(`  title: ${meta.title}`);
  if (meta.goal) lines.push(`  goal: ${meta.goal}`);

  const completed = Object.entries(progress.subtasks)
    .filter(([, st]) => st.status === 'completed');
  if (completed.length > 0) {
    lines.push('  subtasks:');
    for (const [stId, st] of completed) {
      const prefix = st.force_accepted ? '[force-accepted] ' : '';
      const ev = st.evidence ?? '';
      lines.push(`    ${prefix}[${stId}] ${ev}`);
      if (st.last_failed_feedback?.feedback) {
        lines.push(`      ⚠ last_failure: ${st.last_failed_feedback.feedback}`);
      }
    }
  }
  return lines.join('\n');
}


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
          const meta = readContractMeta(fs, path.join(archiveDir, d.name));
          events.push(formatContractCompletedEvent(clawId, d.name, meta, progress));
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

  return events;
}
