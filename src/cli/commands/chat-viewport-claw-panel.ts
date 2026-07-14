/**
 * Claw panel rendering + periodic clawsDir rescan
 * What: debounced claw track rendering and polling-based directory scan
 * When: claw track changes, tick interval fires, or rescan interval fires
 * Why: claw display strategy and rescan logic evolve independently of event stream handling
 */

import * as path from 'path';
import { formatErr } from "../../foundation/node-utils/index.js";
import { getActiveContractTimestamp } from '../../core/contract/index.js';
import { makeClawTrack, buildClawLine, type ClawTrack } from './chat-viewport-claw-line.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { ClawTopology } from '../../core/claw-topology/index.js';
import { makeClawId } from '../../foundation/claw-identity/index.js';
import type { createClawManager } from './chat-viewport-claw-manager.js';
import { VIEWPORT_AUDIT_EVENTS } from './viewport-audit-events.js';
import { DEFAULT_TERMINAL_WIDTH } from '../utils/constants.js';
import { isAlive } from '../../foundation/process-exec/index.js';
import { resolveClawDaemonDir } from '../../core/claw-topology/index.js';
import { STREAM_FILE } from '../../foundation/stream/index.js';

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
    const cols = process.stdout.columns ?? DEFAULT_TERMINAL_WIDTH;
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
  clawTopology: ClawTopology;
  clawTrackMap: Map<string, ClawTrack>;
  clawManager: ReturnType<typeof createClawManager>;
  audit: AuditLog;
  agentDir: string;
  updateClawPanel: (clawTrackMap: Map<string, ClawTrack>) => void;
  pm: { readPid: (daemonDir: import('../../foundation/process-manager/index.js').DaemonDir) => Promise<import('../../foundation/process-manager/index.js').PidReadResult> };
}

export function createRescanClawsDir(deps: RescanClawsDirDeps) {
  return async function rescanClawsDir() {
    try {
      // clawsFs baseDir = clawsDir / 用相对路径 '.' 列 clawsDir 自身
      const entries = deps.clawsFs.listSync('.', { includeDirs: true });
      for (const e of entries) {
        if (!e.isDirectory) continue;
        const clawId = e.name;
        if (deps.clawTrackMap.has(clawId)) continue;
        const location = deps.clawTopology.resolve(makeClawId(clawId));
        if (location.kind !== 'local') continue;
        const clawDir = location.clawDir;
        // getActiveContractTimestamp 用 clawsFs (baseDir=clawsDir) / 传相对路径 clawId
        const contractMs = getActiveContractTimestamp(deps.clawsFs, clawDir);
        if (contractMs !== null) {
          const t = makeClawTrack();
          t.hasContract = true;
          t.referenceMs = contractMs;
          deps.clawTrackMap.set(clawId, t);
          let alive = false;
          try {
            const stored = await deps.pm.readPid(resolveClawDaemonDir(makeClawId(clawId)));
            if (stored.status === 'spawning') {
              t.daemonStatus = 'starting';
            } else if (stored.status === 'io_error' || stored.status === 'corrupt') {
              t.daemonStatus = 'error';
            } else if (stored.status === 'missing') {
              t.daemonStatus = 'stopped';
            } else {
              alive = isAlive(stored.pid);
              t.daemonStatus = alive ? 'running' : 'stopped';
            }
          } catch {
            // silent: pid read failure → treat as not alive (fail-soft)
            t.daemonStatus = 'error';
          }
          if (alive && t.daemonStatus === 'running') {
            deps.clawManager.attachClawWatcher(clawId, path.join(clawDir, STREAM_FILE));
          } else {
            deps.clawManager.refreshClawStatus(clawId);
          }
        }
      }
      if (deps.clawTrackMap.size > 0) {
        deps.updateClawPanel(deps.clawTrackMap);
      }
    } catch (err) {
      const msg = formatErr(err);
      try {
        deps.audit.write(VIEWPORT_AUDIT_EVENTS.CLAWSDIR_SCAN_FAILED, `reason=${msg}`);
      } catch { /* audit self-failure tolerated */ }
    }
  };
}

