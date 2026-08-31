/**
 * @module L4.ContractSystem.OnboardingDiscovery
 * 0-dep pure helper for CLI static phase (pre-init / no ContractSystem instance).
 * Sibling of discovery.ts ctx-injected loadActiveContract.
 */
import * as path from 'node:path';
import type { FileSystem } from '../../foundation/fs/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { formatErr } from '../../foundation/node-utils/index.js';
import {
  CONTRACT_ACTIVE_DIR,
  PROGRESS_FILE,
  CONTRACT_YAML_FILE,
} from './dirs.js';
import { listArchiveContractLocations, archiveContainerDir } from './locations.js';
import { CONTRACT_AUDIT_EVENTS } from './audit-events.js';

type OnboardingStatusKind = 'not_found' | 'in_progress' | 'complete';

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
  // phase 1127 Step C: scan active dir first, then current archive state dirs + legacy flat.
  const archiveEntries = listArchiveContractLocations({ fs, archiveDir: archiveContainerDir() });
  if (fs.existsSync(CONTRACT_ACTIVE_DIR)) {
    let entries: string[] = [];
    try { entries = fs.listSync(CONTRACT_ACTIVE_DIR, { includeDirs: true }).map(e => e.name); } catch { /* silent: TOCTOU race or ENOENT during dir scan */ }
    for (const contractId of entries) {
      const contractYaml = path.join(CONTRACT_ACTIVE_DIR, contractId, CONTRACT_YAML_FILE);
      const progressJson = path.join(CONTRACT_ACTIVE_DIR, contractId, PROGRESS_FILE);
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
        continue;
      }
      const subtasks = progress.subtasks ?? {};
      const pending = Object.entries(subtasks)
        .filter(([, v]) => v.status !== 'completed')
        .map(([k]) => k);
      return { state: 'in_progress', contractId, pending };
    }
  }

  for (const entry of archiveEntries) {
    const contractYaml = path.join(entry.contractRoot, CONTRACT_YAML_FILE);
    const progressJson = path.join(entry.contractRoot, PROGRESS_FILE);
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
      continue;
    }
    const subtasks = progress.subtasks ?? {};
    const pending = Object.entries(subtasks)
      .filter(([, v]) => v.status !== 'completed')
      .map(([k]) => k);
    if (pending.length === 0) {
      return { state: 'complete' };
    }
    return { state: 'in_progress', contractId: entry.contractId, pending };
  }

  return { state: 'not_found' };
}
