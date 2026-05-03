import * as path from 'path';
import type { FileSystem } from '../../../foundation/fs/types.js';
import type { ProgressData } from '../manager.js';
import { CONTRACT_DIR } from '../../../types/paths.js';

export function collectContractEvents(
  fs: FileSystem,
  clawDir: string,
  clawId: string,
  sinceTs: number,
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
        const progress = JSON.parse(raw) as ProgressData;
        const completedAfter = Object.values(progress.subtasks)
          .some(s => s.completed_at && new Date(s.completed_at).getTime() > sinceTs);
        if (completedAfter && progress.status === 'completed') {
          events.push(`[contract_completed] claw=${clawId} contract=${d.name}`);
        }
      } catch { /* 跳过单 contract */ }
    }
  } catch { /* archive 不存在 */ }

  // 2. active 中升级事件
  const activeDir = path.join(clawDir, CONTRACT_DIR, 'active');
  try {
    const dirs = fs.listSync(activeDir, { includeDirs: true })
      .filter(e => e.isDirectory);
    for (const d of dirs) {
      const progressPath = path.join(activeDir, d.name, 'progress.json');
      try {
        const raw = fs.readSync(progressPath);
        const progress = JSON.parse(raw) as ProgressData;
        for (const [stId, st] of Object.entries(progress.subtasks)) {
          if (st.escalated_at && new Date(st.escalated_at).getTime() > sinceTs) {
            events.push(`[contract_escalation] claw=${clawId} contract=${d.name} subtask=${stId} retry_count=${st.retry_count}`);
          }
        }
      } catch { /* 跳过 */ }
    }
  } catch { /* active 不存在 */ }

  return events;
}
