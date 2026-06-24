/**
 * @module L4.ContractSystem.OnboardingDiscovery
 * 0-dep pure helper for CLI static phase (pre-init / no ContractSystem instance).
 * Sibling of discovery.ts ctx-injected loadActiveContract/loadPausedContract.
 */
import * as path from 'node:path';
import type { FileSystem } from '../../foundation/fs/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { formatErr } from '../../foundation/node-utils/index.js';
import {
  CONTRACT_ACTIVE_DIR,
  CONTRACT_PAUSED_DIR,
  CONTRACT_ARCHIVE_DIR,
  PROGRESS_FILE,
  CONTRACT_YAML_FILE,
} from './dirs.js';
import { CONTRACT_AUDIT_EVENTS } from './audit-events.js';

export type OnboardingStatusKind = 'not_found' | 'in_progress' | 'complete';

export interface OnboardingStatus {
  state: OnboardingStatusKind;
  contractId?: string;
  pending?: string[];
}

interface ProgressSubtask { status?: string; }
interface ProgressShape { subtasks?: Record<string, ProgressSubtask>; }

/**
 * 取一个 onboarding contract atomic snapshot：(state, contractId?, pending?)
 * - 0 ContractSystem instance dep
 * - fs 可注入便于 mock TOCTOU race simulate
 * - retains 6-site silent-swallow semantics (catch-blocks with continue)
 * - audit optional：CLI 静态阶段无 audit infra 时跳过、有则 emit forensics
 */
export function readOnboardingStatus(
  motionDir: string,
  deps: { fsFactory: (baseDir: string) => FileSystem; audit?: AuditLog },
): OnboardingStatus {
  const fs = deps.fsFactory(motionDir);
  const dirs: ReadonlyArray<readonly [string, OnboardingStatusKind | 'archive_complete']> = [
    [CONTRACT_ACTIVE_DIR, 'in_progress'],
    [CONTRACT_PAUSED_DIR, 'in_progress'],
    [CONTRACT_ARCHIVE_DIR, 'archive_complete'],
  ];
  for (const [dir, kind] of dirs) {
    if (!fs.existsSync(dir)) continue;
    let entries: string[];
    try { entries = fs.listSync(dir, { includeDirs: true }).map(e => e.name); } catch { /* silent: TOCTOU race or ENOENT during dir scan — skip to next dir */ continue; }
    for (const contractId of entries) {
      const contractYaml = path.join(dir, contractId, CONTRACT_YAML_FILE);
      const progressJson = path.join(dir, contractId, PROGRESS_FILE);
      if (!fs.existsSync(contractYaml) || !fs.existsSync(progressJson)) continue;
      let title = '';
      try {
        const yaml = fs.readSync(contractYaml);
        const m = yaml.match(/^title:\s*["']?(.+?)["']?\s*$/m);
        title = m?.[1] ?? '';
      } catch { /* silent: contract.yaml read race — skip to next contract */ continue; }
      if (title !== 'Onboarding') continue;
      let progress: ProgressShape;
      try {
        progress = JSON.parse(fs.readSync(progressJson)) as ProgressShape;
      } catch (err) {
        deps.audit?.write(
          CONTRACT_AUDIT_EVENTS.CONTRACT_ONBOARDING_PROGRESS_PARSE_FAILED,
          `path=${progressJson}`,
          `error=${formatErr(err)}`,
        );
        continue; // silent: progress.json read race or parse error — skip to next contract（forensics emit 上面）
      }
      const subtasks = progress.subtasks ?? {};
      const pending = Object.entries(subtasks)
        .filter(([, v]) => v.status !== 'completed')
        .map(([k]) => k);
      if (kind === 'archive_complete' && pending.length === 0) {
        return { state: 'complete' };
      }
      return { state: 'in_progress', contractId, pending };
    }
  }
  return { state: 'not_found' };
}
