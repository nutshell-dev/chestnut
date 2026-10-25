/**
 * Claw panel rendering + periodic clawsDir rescan
 * What: debounced claw track rendering and polling-based directory scan
 * When: claw track changes, tick interval fires, or rescan interval fires
 * Why: claw display strategy and rescan logic evolve independently of event stream handling
 */

import * as path from 'path';
import { formatErr } from "../foundation/node-utils/index.js";
import { getActiveContractTimestamp } from '../core/contract/index.js';
import { makeClawTrack, buildClawLine, type ClawTrack } from './chat-viewport-claw-line.js';
import type { FileSystem } from '../foundation/fs/index.js';
import type { AuditLog } from '../foundation/audit/index.js';
import type { ClawTopology } from '../core/claw-topology/index.js';
import { MOTION_CLAW_ID } from '../core/claw-topology/index.js';
import type { createClawManager } from './chat-viewport-claw-manager.js';
import { VIEWPORT_AUDIT_EVENTS } from './viewport-audit-events.js';
import {  DEFAULT_TERMINAL_WIDTH  } from './terminal-text.js';

import { resolveClawDaemonDir } from '../core/claw-topology/index.js';
import { STREAM_FILE } from '../foundation/stream/index.js';

interface ClawPanelDeps {
  attachedClawBar: { setText(text: string): void };
  requestRender?: () => void;
}

export function createClawPanel(deps: ClawPanelDeps) {
  let updateClawPanelScheduled = false;
  let lastMaterializedText: string | null = null;

  const _computeText = (clawTrackMap: Map<string, ClawTrack>): string => {
    if (clawTrackMap.size === 0) {
      return '';
    }
    const cols = process.stdout.columns ?? DEFAULT_TERMINAL_WIDTH;
    const lines: string[] = [];
    for (const [id, t] of clawTrackMap) {
      lines.push(buildClawLine(id, t, cols));
    }
    return lines.join('\n');
  };

  const _renderClawPanel = (clawTrackMap: Map<string, ClawTrack>) => {
    const text = _computeText(clawTrackMap);
    if (text === lastMaterializedText) return;
    lastMaterializedText = text;
    deps.attachedClawBar.setText(text);
    deps.requestRender?.();
  };

  // startup 专用：同步计算并 setText，更新 lastMaterializedText；不 requestRender
  const materializeNow = (clawTrackMap: Map<string, ClawTrack>) => {
    lastMaterializedText = _computeText(clawTrackMap);
    deps.attachedClawBar.setText(lastMaterializedText);
  };

  // runtime debounced：nextTick 计算最终文本；若 === last 则 return；
  // 否则 setText、更新 last、requestRender
  const updateClawPanel = (clawTrackMap: Map<string, ClawTrack>) => {
    if (updateClawPanelScheduled) return;
    updateClawPanelScheduled = true;
    process.nextTick(() => {
      updateClawPanelScheduled = false;
      _renderClawPanel(clawTrackMap);
    });
  };

  return { _renderClawPanel, materializeNow, updateClawPanel };
}

interface RescanClawsDirDeps {
  // Phase 1997 Step C: claw 发现归 ClawTopology；contract 读取用各 claw 自己的 FS
  // （fsFactory(location.clawDir)），不再共享 clawsFs raw listSync。
  fsFactory: (baseDir: string) => FileSystem;
  clawTopology: ClawTopology;
  clawTrackMap: Map<string, ClawTrack>;
  clawManager: ReturnType<typeof createClawManager>;
  audit: AuditLog;
  agentDir: string;
  updateClawPanel: (clawTrackMap: Map<string, ClawTrack>) => void;
  pm: {
    inspectSpawning: (daemonDir: import('../foundation/process-manager/index.js').DaemonDir) => { status: string; record?: { generation_id: string } };
    // phase 1773: boolean convenience 注入（单一 liveness probe 的单行投影）
    isAlive: (daemonDir: import('../foundation/process-manager/index.js').DaemonDir) => boolean;
  };
}

export function createRescanClawsDir(deps: RescanClawsDirDeps) {
  // Phase 1997 Step D: 扫描失败审计按状态变迁写——同一失败指纹只写一次，
  // 恢复写一次 recovered；不再每 tick（2s）重复刷屏。状态在 viewport 进程内；
  // 重启后首次失败再写一次属正常“新会话”状态。
  let lastScanFailure: string | null = null;
  return async function rescanClawsDir() {
    try {
      // Phase 1997 Step C: claw 枚举归 ClawTopology.enumerateSnapshot()
      // （valid 含系统 Motion 与 normal claws；topology 已跳过 claws/motion 同名目录——
      // legacy fixture 不会被误解析成系统 Motion）。
      const snapshot = deps.clawTopology.enumerateSnapshot();
      for (const clawId of snapshot.valid) {
        if (clawId === MOTION_CLAW_ID) continue;      // 系统 Motion 不在 normal claw 扫描
        if (deps.clawTrackMap.has(clawId)) continue;
        const location = deps.clawTopology.resolve(clawId);
        const clawDir = location.clawDir;
        // contract 读取用该 claw 自己的 FS（root=location.clawDir），相对 '.' 即 claw 根；
        // 不把绝对路径/共享 base 交给 query owner（消除 double-prefix/absolute 拒绝）。
        const clawFs = deps.fsFactory(clawDir);
        const contractMs = getActiveContractTimestamp(clawFs, '.');
        if (contractMs !== null) {
          const t = makeClawTrack();
          t.hasContract = true;
          t.referenceMs = contractMs;
          deps.clawTrackMap.set(clawId, t);
          let alive = false;
          try {
            const daemonDir = resolveClawDaemonDir(clawId);
            const spawning = deps.pm.inspectSpawning(daemonDir);
            if (spawning.status === 'ok') {
              t.daemonStatus = 'starting';
            } else if (spawning.status === 'malformed') {
              t.daemonStatus = 'error';
            } else {
              alive = deps.pm.isAlive(daemonDir);
              t.daemonStatus = alive ? 'running' : 'stopped';
            }
          } catch {
            // silent: status read failure → treat as not alive (fail-soft)
            t.daemonStatus = 'error';
          }
          if (alive && t.daemonStatus === 'running') {
            deps.clawManager.attachClawWatcher(clawId, path.join(clawDir, STREAM_FILE));
          } else {
            deps.clawManager.refreshClawStatus(clawId);
          }
        }
      }
      if (lastScanFailure !== null) {
        try {
          deps.audit.write(VIEWPORT_AUDIT_EVENTS.CLAWSDIR_SCAN_RECOVERED);
        } catch { /* audit self-failure tolerated */ }
        lastScanFailure = null;
      }
      deps.updateClawPanel(deps.clawTrackMap);
    } catch (err) {
      const msg = formatErr(err);
      if (msg !== lastScanFailure) {
        try {
          deps.audit.write(VIEWPORT_AUDIT_EVENTS.CLAWSDIR_SCAN_FAILED, `reason=${msg}`);
        } catch { /* audit self-failure tolerated */ }
        lastScanFailure = msg;
      }
    }
  };
}
