/**
 * @module L4.ContractSystem.OnboardingDiscovery
 * 0-dep pure helper for CLI static phase (pre-init / no ContractSystem instance).
 * Sibling of discovery.ts ctx-injected loadActiveContract/loadPausedContract.
 */
import * as nodeFs from 'node:fs';
import * as path from 'node:path';
import {
  CONTRACT_ACTIVE_DIR,
  CONTRACT_PAUSED_DIR,
  CONTRACT_ARCHIVE_DIR,
} from './dirs.js';

export type OnboardingStatusKind = 'not_found' | 'in_progress' | 'complete';

export interface OnboardingStatus {
  state: OnboardingStatusKind;
  contractId?: string;
  pending?: string[];
}

interface MinimalFs {
  existsSync(p: string): boolean;
  readdirSync(p: string): string[];
  readFileSync(p: string, enc: 'utf-8'): string;
}

interface ProgressSubtask { status?: string; }
interface ProgressShape { subtasks?: Record<string, ProgressSubtask>; }

/**
 * 取一个 onboarding contract atomic snapshot：(state, contractId?, pending?)
 * - 0 audit dep (CLI 静态阶段无 audit infra)
 * - 0 ContractSystem instance dep
 * - fs 可注入便于 mock TOCTOU race simulate
 * - retains 6-site silent-swallow semantics (catch-blocks with continue)
 * - 未来如需 race observability、加 audit emit hook（推升档锚 (c) 命中后）
 */
export function readOnboardingStatus(
  motionDir: string,
  fs: MinimalFs = nodeFs,
): OnboardingStatus {
  const dirs: ReadonlyArray<readonly [string, OnboardingStatusKind | 'archive_complete']> = [
    [CONTRACT_ACTIVE_DIR, 'in_progress'],
    [CONTRACT_PAUSED_DIR, 'in_progress'],
    [CONTRACT_ARCHIVE_DIR, 'archive_complete'],
  ];
  for (const [dir, kind] of dirs) {
    const contractsDir = path.join(motionDir, dir);
    if (!fs.existsSync(contractsDir)) continue;
    let entries: string[];
    try { entries = fs.readdirSync(contractsDir); } catch { /* silent: TOCTOU race or ENOENT during dir scan — skip to next dir */ continue; }
    for (const contractId of entries) {
      const contractYaml = path.join(contractsDir, contractId, 'contract.yaml');
      const progressJson = path.join(contractsDir, contractId, 'progress.json');
      if (!fs.existsSync(contractYaml) || !fs.existsSync(progressJson)) continue;
      let title = '';
      try {
        const yaml = fs.readFileSync(contractYaml, 'utf-8');
        const m = yaml.match(/^title:\s*["']?(.+?)["']?\s*$/m);
        title = m?.[1] ?? '';
      } catch { /* silent: contract.yaml read race — skip to next contract */ continue; }
      if (title !== 'Onboarding') continue;
      let progress: ProgressShape;
      try {
        progress = JSON.parse(fs.readFileSync(progressJson, 'utf-8')) as ProgressShape;
      } catch { /* silent: progress.json read race or parse error — skip to next contract */ continue; }
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
