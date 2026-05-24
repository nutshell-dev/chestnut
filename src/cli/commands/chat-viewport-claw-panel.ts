/**
 * Claw panel rendering + periodic clawsDir rescan
 * What: debounced claw track rendering and polling-based directory scan
 * When: claw track changes, tick interval fires, or rescan interval fires
 * Why: claw display strategy and rescan logic evolve independently of event stream handling
 */

import * as path from 'path';
import { getContractCreatedMs } from '../../core/contract/index.js';
import { makeClawTrack, buildClawLine, type ClawTrack } from './chat-viewport-claw-line.js';
import { STREAM_FILE } from '../../foundation/stream/index.js';
import type { FileSystem } from '../../foundation/fs/types.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { createClawManager } from './chat-viewport-claw-manager.js';
import { VIEWPORT_AUDIT_EVENTS } from './viewport-audit-events.js';

export interface ClawPanelDeps {
  attachedClawBar: { setText(text: string): void };
}

export function createClawPanel(deps: ClawPanelDeps) {
  let updateClawPanelScheduled = false;

  const _renderClawPanel = (clawTrackMap: Map<string, ClawTrack>) => {
    if (clawTrackMap.size === 0) {
      deps.attachedClawBar.setText('');
      return;
    }
    const cols = process.stdout.columns ?? 80;
    const lines: string[] = [];
    for (const [id, t] of clawTrackMap) {
      lines.push(buildClawLine(id, t, cols));
    }
    deps.attachedClawBar.setText(lines.join('\n'));
  };

  const updateClawPanel = (clawTrackMap: Map<string, ClawTrack>) => {
    if (updateClawPanelScheduled) return;
    updateClawPanelScheduled = true;
    process.nextTick(() => {
      updateClawPanelScheduled = false;
      _renderClawPanel(clawTrackMap);
    });
  };

  return { _renderClawPanel, updateClawPanel };
}

export interface RescanClawsDirDeps {
  clawsFs: FileSystem;
  clawsDir: string;
  clawTrackMap: Map<string, ClawTrack>;
  clawManager: ReturnType<typeof createClawManager>;
  audit: AuditLog;
  agentDir: string;
  updateClawPanel: (clawTrackMap: Map<string, ClawTrack>) => void;
}

export function createRescanClawsDir(deps: RescanClawsDirDeps) {
  return function rescanClawsDir() {
    try {
      // clawsFs baseDir = clawsDir / 用相对路径 '.' 列 clawsDir 自身
      const entries = deps.clawsFs.listSync('.', { includeDirs: true });
      for (const e of entries) {
        if (!e.isDirectory) continue;
        const clawId = e.name;
        if (deps.clawTrackMap.has(clawId)) continue;
        const clawDir = path.join(deps.clawsDir, clawId);
        // getContractCreatedMs 用 clawsFs (baseDir=clawsDir) / 传相对路径 clawId
        const contractMs = getContractCreatedMs(deps.clawsFs, clawId, deps.audit);
        if (contractMs !== null) {
          const t = makeClawTrack();
          t.hasContract = true;
          t.referenceMs = contractMs;
          deps.clawTrackMap.set(clawId, t);
          // 开 watcher
          deps.clawManager.attachClawWatcher(clawId, path.join(clawDir, STREAM_FILE));
        }
      }
      if (deps.clawTrackMap.size > 0) {
        deps.updateClawPanel(deps.clawTrackMap);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      try {
        deps.audit.write(VIEWPORT_AUDIT_EVENTS.CLAWSDIR_SCAN_FAILED, `reason=${msg}`);
      } catch { /* audit self-failure tolerated */ }
    }
  };
}

