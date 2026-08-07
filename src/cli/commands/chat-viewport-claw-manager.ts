import * as path from 'path';
import { formatErr } from "../../foundation/node-utils/index.js";

import { getActiveContractTimestamp } from '../../core/contract/index.js';
import { parseStreamLines } from '../../foundation/stream/index.js';
import { STREAM_FILE } from '../../foundation/stream/index.js';
import type { StreamEvent } from '../../foundation/stream/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import { isFileNotFound } from '../../foundation/fs/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { VIEWPORT_AUDIT_EVENTS } from './viewport-audit-events.js';
import { MOTION_CLAW_ID, resolveClawDaemonDir } from '../../core/claw-topology/index.js';
import { makeClawId } from '../../foundation/claw-identity/index.js';
import type { ClawTopology } from '../../core/claw-topology/index.js';
import type { DaemonDir } from '../../foundation/process-manager/index.js';
import { type ClawTrack, makeClawTrack } from './chat-viewport-claw-line.js';
import { createChatViewportWatcher, type Watcher } from './chat-viewport-watcher.js';


export interface ClawManagerDeps {
  fs: FileSystem;
  pm: {
    inspectSpawning: (daemonDir: DaemonDir) => { status: string; record?: { generation_id: string } };
    getAliveStatus: (daemonDir: DaemonDir) => { alive: boolean; reason: string; pid?: number };
  };
  audit: AuditLog;
  isMotion: boolean;
  clawTopology: ClawTopology;
  clawTrackMap: Map<string, ClawTrack>;
  updateClawPanel: (clawTrackMap: Map<string, ClawTrack>) => void;
}

export interface ClawManager {
  attachClawWatcher(clawId: string, streamFile: string): void;
  refreshClawStatus(clawId: string): void;
  refreshAllClawStatus(): Promise<void>;
  detachWatcher(clawId: string): Promise<void>;
  detachAllWatchers(): Promise<void>;
  closeAll(): Promise<void>;
}

/**
 * ClawTrack textBuffer 上限 / 防 UI 内存膨胀.
 * Derivation: 64 * 1024 = 64KB ≈ 30K 中文字 / 足够显示典型 LLM turn 完整 text stream /
 * 超 cap 时 ring-buffer 滚旧 / 比 RESULT_SINGLE_LINE_MAX (60 char) 大 1000× 因 textBuffer 累全 turn.
 */
const TEXT_BUFFER_CAP = 64 * 1024;

/**
 * 截断 textBuffer 后保留最近 N 字节（滑动窗口）.
 * Derivation: 32 * 1024 = 32KB = TEXT_BUFFER_CAP (64KB) / 2 / 1/2 cap 给截断后保留近期
 * 上下文足够 LLM 看清最近上下文 / 滑动窗口给用户感知平稳（不全清空）.
 */
const TEXT_BUFFER_KEEP = 32 * 1024;

const appendCappedBuffer = (track: ClawTrack, delta: string) => {
  track.textBuffer += delta;
  if (track.textBuffer.length > TEXT_BUFFER_CAP) {
    track.textBuffer = track.textBuffer.slice(-TEXT_BUFFER_KEEP);
  }
};

export const createClawManager = (deps: ClawManagerDeps): ClawManager => {
  const { fs, pm, audit, isMotion, clawTopology, clawTrackMap, updateClawPanel } = deps;
  const clawWatchers = new Map<string, Watcher>();
  const clawWatcherVersions = new Map<string, number>();

  const attachClawWatcher = (clawId: string, streamFile: string) => {
    // close previous watcher if re-attaching same claw (defensive, caller already guards)
    const prev = clawWatchers.get(clawId);
    if (prev) {
      prev.close().catch(() => { /* silent: cleanup */ });
      clawWatchers.delete(clawId);
    }

    const ver = (clawWatcherVersions.get(clawId) ?? 0) + 1;
    clawWatcherVersions.set(clawId, ver);
    try {
      const w = createChatViewportWatcher(
        fs, clawId, streamFile,
        () => {
          if (clawWatcherVersions.get(clawId) !== ver) return;
          refreshClawStatus(clawId);
        },
        audit,
        () => {
          if (clawWatcherVersions.get(clawId) === ver) clawWatchers.delete(clawId);
        },
        false,
      );
      clawWatchers.set(clawId, w);
    } catch {
      // silent: fs.watch unsupported / ENOENT — caller already armed polling refresh as fallback, no degradation
    }
  };

  const refreshClawStatus = (clawId: string): void => {
    if (!isMotion) return;
    const track = clawTrackMap.get(clawId);
    if (!track) return;
    const location = clawTopology.resolve(makeClawId(clawId));
    if (location.kind !== 'local') return;
    const streamFile = path.join(location.clawDir, STREAM_FILE);
    try {
      const stat = fs.statSync(streamFile);
      if (stat.size < track.fileSize) {
        // stream 被截断或重建：重置 track，变化检测由递归 clawsWatcher 负责
        track.fileSize = 0; track.leftover = '';
        track.turnCount = 0; track.step = 0; track.active = false; track.lastError = null;
        track.currentTool = null; track.toolSuccess = null; track.textBuffer = '';
        track.bufferType = null; track.lastOutput = ''; track.lastInterrupted = false;
        track.clearOnNextDelta = false;
        track.maxSteps = 100; track.referenceMs = null;
      }
      if (stat.size > track.fileSize) {
        const buf = fs.readBytesSync(streamFile, track.fileSize, stat.size);
        track.fileSize += buf.length;
        const { events, leftover } = parseStreamLines(buf.toString('utf-8'), track.leftover);
        track.leftover = leftover;
        for (const ev of events as StreamEvent[]) {
          try {
            switch (ev.type) {
              case 'turn_start':
                track.turnCount++; track.step = 0; track.active = true;
                track.lastOutput = '';
                track.lastInterrupted = false;
                track.currentTool = null;
                track.textBuffer = '';
                track.toolSuccess = null;
                track.bufferType = null;
                track.clearOnNextDelta = false;
                break;
              case 'tool_result':
                track.step = ev.step ?? track.step;
                track.maxSteps = ev.maxSteps ?? track.maxSteps;
                track.toolSuccess = ev.success ?? null;
                break;
              case 'turn_error':
                track.active = false; track.lastError = ev.error ?? 'error';
                track.lastOutput = ''; track.referenceMs = Date.now();
                break;
              case 'turn_end':
                track.active = false; track.lastError = null;
                if (track.textBuffer) track.lastOutput = track.textBuffer;
                track.referenceMs = Date.now();
                break;
              case 'turn_interrupted':
                track.active = false; track.lastError = null;
                track.lastInterrupted = true; track.lastOutput = '';
                track.referenceMs = Date.now();
                break;
              case 'thinking_delta': {
                if (track.active === false) track.lastOutput = '';
                track.active = true;
                if (track.clearOnNextDelta) {
                  track.textBuffer = ''; track.bufferType = null;
                  track.toolSuccess = null; track.clearOnNextDelta = false;
                }
                appendCappedBuffer(track, ev.delta ?? '');
                track.bufferType = 'thinking';
                break;
              }
              case 'tool_call': {
                if (track.active === false) track.lastOutput = '';
                track.active = true;
                if (track.toolSuccess !== null) {
                  track.textBuffer = ''; track.bufferType = null; track.clearOnNextDelta = false;
                } else {
                  track.clearOnNextDelta = true;
                }
                track.currentTool = ev.name ?? null;
                track.toolSuccess = null;
                break;
              }
              case 'text_delta': {
                if (track.active === false) track.lastOutput = '';
                track.active = true;
                if (track.bufferType !== 'text' || track.clearOnNextDelta) {
                  track.textBuffer = ''; track.bufferType = 'text'; track.toolSuccess = null; track.clearOnNextDelta = false;
                }
                appendCappedBuffer(track, ev.delta ?? '');
                break;
              }
              case 'user_reply_delta':
              case 'user_reply_end': {
                // 原 LLM_OUTPUT_EVENTS 通用分支：仅 active/lastOutput（无专用处理）
                if (track.active === false) track.lastOutput = '';
                track.active = true;
                break;
              }
              // 非消费类型显式声明：claw track 不消费（保持原 if/else 未匹配静默语义）
              case 'llm_start': case 'text_end': case 'tool_use_input':
              case 'provider_info': case 'provider_failover': case 'provider_failed':
              case 'llm_retry_waiting': case 'provider_attempt_failed': case 'retry_scheduled':
              case 'provider_exhausted': case 'fallback_switched': case 'breaker_opened':
              case 'breaker_half_open': case 'breaker_closed': case 'healthcheck_failed':
              case 'stream_reset': case 'stream_parse_error': case 'tool_arg_parse_error':
              case 'idle_failover_triggered': case 'stream_idle_probe_attempted': case 'stream_idle_probe_succeeded':
              case 'context_exceeded_failover': case 'context_exceeded_throwthrough': case 'permanent_skip_retry':
              case 'hedge_started': case 'hedge_primary_recovered': case 'hedge_primary_post_first_chunk_failure':
              case 'hedge_fallback_committed': case 'hedge_primary_succeeded_after_race_lost':
              case 'all_providers_context_exceeded': case 'race_loser_cleaned':
              case 'sdk_client_cache_hit': case 'sdk_client_cache_miss': case 'provider_close_failed':
              case 'system_notify':
              case 'session_boundary': case 'daemon_started':
              case 'task_started': case 'task_completed': case 'task_attempt_start':
                break;
              default: {
                const _exhaustive: never = ev;
                void _exhaustive;
              }
            }
          } catch {
            // silent: malformed event skip — single event parse failure, next event continues; track partial state remains
          }
        }
        updateClawPanel(clawTrackMap);
      }
    } catch {
      // silent: stream file ENOENT / IO error — polling retries next interval, claw not yet running OR file not yet created
    }
  };

  const refreshAllClawStatus = async (): Promise<void> => {
    if (!isMotion) return;
    let clawIds: string[] = [];
    try {
      clawIds = clawTopology.enumerate().filter(id => id !== MOTION_CLAW_ID);
    } catch (err) {
      // phase 979 (r120 C fork / phase 975 B-α2):
      // ENOENT (clawsDir 首次启动) silent OK / non-ENOENT (FS perm / NFS hang / EACCES) audit emit 防 orphan watcher silent 累
      if (!isFileNotFound(err)) {
        const code = (err as { code?: string })?.code;
        audit.write(VIEWPORT_AUDIT_EVENTS.REFRESH_CLAWS_FAILED, `code=${code ?? 'unknown'}`, `error=${formatErr(err)}`);
      }
      return;
    }

    for (const [id] of clawTrackMap) {
      if (!clawIds.includes(id)) {
        clawTrackMap.delete(id);
      }
    }

    for (const rawClawId of clawIds) {
      const clawId = rawClawId;
      const loc = clawTopology.resolve(makeClawId(clawId));
      if (loc.kind !== 'local') continue;
      if (!clawTrackMap.has(clawId)) {
        const clawDir = loc.clawDir;
        const contractMs = getActiveContractTimestamp(fs, clawDir);
        if (contractMs === null) continue;
        const track = makeClawTrack();
        track.hasContract = true;
        track.referenceMs = contractMs;
        clawTrackMap.set(clawId, track);
      }
      const track = clawTrackMap.get(clawId)!;
      try {
        const daemonDir = resolveClawDaemonDir(makeClawId(clawId));
        const spawning = pm.inspectSpawning(daemonDir);
        if (spawning.status === 'ok') {
          track.daemonStatus = 'starting';
          track.isAlive = false;
        } else if (spawning.status === 'malformed') {
          track.daemonStatus = 'error';
          track.isAlive = false;
        } else {
          const { alive } = pm.getAliveStatus(daemonDir);
          track.isAlive = alive;
          track.daemonStatus = alive ? 'running' : 'stopped';
        }
      } catch (e) {
        if (!isFileNotFound(e)) {
          process.stderr.write(`[viewport] status check failed: ${(e as Error).message}\n`);
        }
        track.daemonStatus = 'error';
        track.isAlive = false;
      }
      const loc2 = clawTopology.resolve(makeClawId(clawId));
      if (loc2.kind !== 'local') continue;
      track.hasContract = getActiveContractTimestamp(fs, loc2.clawDir) !== null;
      if (track.isAlive && track.daemonStatus === 'running' && !clawWatchers.has(clawId)) {
        const streamFile = path.join(loc2.clawDir, STREAM_FILE);
        attachClawWatcher(clawId, streamFile);
      }
      refreshClawStatus(clawId);
    }
  };

  const detachWatcher = async (clawId: string): Promise<void> => {
    await clawWatchers.get(clawId)?.close();
    clawWatchers.delete(clawId);
  };

  const detachAllWatchers = async (): Promise<void> => {
    for (const [id] of Array.from(clawWatchers.keys())) {
      await clawWatchers.get(id)?.close();
      clawWatchers.delete(id);
    }
  };

  const closeAll = async (): Promise<void> => {
    const entries = Array.from(clawWatchers.entries());
    const results = await Promise.allSettled(entries.map(([, w]) => w.close()));
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        const [id] = entries[i];
        // best-effort finalizer / log 仅 / 不抛
        console.warn(`[chat-viewport] failed to close claw watcher ${id}: ${String(r.reason)}`);
      }
    });
    clawWatchers.clear();
    clawWatcherVersions.clear();
  };

  return { attachClawWatcher, refreshClawStatus, refreshAllClawStatus, detachWatcher, detachAllWatchers, closeAll };
};
