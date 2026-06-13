import * as path from 'path';
import { formatErr } from "../../foundation/utils/index.js";
import { isAlive } from '../../foundation/process-exec/index.js';
import { getContractCreatedMs } from '../../core/contract/index.js';
import { LLM_OUTPUT_EVENTS } from '../../foundation/stream/index.js';
import { STREAM_FILE } from '../../foundation/stream/index.js';
import type { Watcher } from '../../foundation/file-watcher/index.js';
import type { FileSystem } from '../../foundation/fs/types.js';
import { isFileNotFound } from '../../foundation/fs/types.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { VIEWPORT_AUDIT_EVENTS } from './viewport-audit-events.js';
import { MOTION_CLAW_ID, makeClawId } from '../../constants.js';
import type { ClawTopology } from '../../core/claw-topology/index.js';
import { createChatViewportWatcher } from './chat-viewport-watcher.js';
import { type ClawTrack, makeClawTrack } from './chat-viewport-claw-line.js';


export interface ClawManagerDeps {
  fs: FileSystem;
  pm: { readPid: (label: import('../../constants.js').ClawId) => Promise<{ pid: number; startTime?: string } | null> };
  audit: AuditLog;
  isMotion: boolean;
  clawTopology: ClawTopology;
  clawTrackMap: Map<string, ClawTrack>;
  updateClawPanel: (clawTrackMap: Map<string, ClawTrack>) => void;
  requestRender: () => void;
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
  const { fs, pm, audit, isMotion, clawTopology, clawTrackMap, updateClawPanel, requestRender } = deps;
  const clawWatchers = new Map<string, Watcher>();
  const clawWatcherVersions = new Map<string, number>();

  const attachClawWatcher = (clawId: string, streamFile: string) => {
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
        const stale = clawWatchers.get(clawId);
        if (stale) { void stale.close(); clawWatchers.delete(clawId); }
        attachClawWatcher(clawId, streamFile);
        track.fileSize = 0; track.leftover = '';
        track.turnCount = 0; track.step = 0; track.active = false; track.lastError = null;
        track.currentTool = null; track.toolSuccess = null; track.textBuffer = '';
        track.bufferType = null; track.lastOutput = ''; track.lastInterrupted = false;
        track.clearOnNextDelta = false;
      }
      if (stat.size > track.fileSize) {
        const buf = fs.readBytesSync(streamFile, track.fileSize, stat.size);
        track.fileSize += buf.length;
        const chunk = track.leftover + buf.toString('utf-8');
        const lines = chunk.split('\n');
        track.leftover = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const ev = JSON.parse(line);
            if (ev.type === 'turn_start') { track.turnCount++; track.step = 0; track.active = true; }
            else if (ev.type === 'tool_result') { track.step = ev.step ?? track.step; track.maxSteps = ev.maxSteps ?? track.maxSteps; }
            else if (ev.type === 'turn_error') { track.active = false; track.lastError = (ev.error as string) ?? 'error'; }
            else if (ev.type === 'turn_end' || ev.type === 'turn_interrupted') { track.active = false; track.lastError = null; }

            if (LLM_OUTPUT_EVENTS.has(ev.type)) {
              if (track.active === false) track.lastOutput = '';
              track.active = true;
              if (ev.type === 'thinking_delta') {
                if (track.clearOnNextDelta) {
                  track.textBuffer = '';
                  track.bufferType = null;
                  track.clearOnNextDelta = false;
                }
                appendCappedBuffer(track, (ev.delta as string) ?? '');
                track.bufferType = 'thinking';
              } else if (ev.type === 'tool_call') {
                // 首轮 tool_call（toolSuccess 仍 null）保留旧 thinking/text 显示执行上下文；
                // 续轮（上一 tool 已 result、toolSuccess 已非 null）旧 buffer 已显示一轮，立即清防 stale 跨多 round 滞留。
                // user 2026-05-29 ratify by phase 1429.
                if (track.toolSuccess !== null) {
                  track.textBuffer = '';
                  track.bufferType = null;
                  track.clearOnNextDelta = false;
                } else {
                  track.clearOnNextDelta = true;
                }
                track.currentTool = (ev.name as string) ?? null;
                track.toolSuccess = null;
              } else if (ev.type === 'text_delta') {
                if (track.bufferType !== 'text' || track.clearOnNextDelta) {
                  track.textBuffer = '';
                  track.bufferType = 'text';
                  track.clearOnNextDelta = false;
                }
                appendCappedBuffer(track, (ev.delta as string) ?? '');
              }
            } else if (ev.type === 'tool_result') {
              track.toolSuccess = (ev.success as boolean) ?? null;
            } else if (ev.type === 'turn_start') {
              track.lastOutput = '';
              track.lastInterrupted = false;
            } else if (ev.type === 'turn_end') {
              track.active = false; track.lastInterrupted = false;
              if (track.textBuffer) track.lastOutput = track.textBuffer;
              track.currentTool = null; track.textBuffer = '';
              track.toolSuccess = null; track.bufferType = null; track.clearOnNextDelta = false;
              track.referenceMs = Date.now();
            } else if (ev.type === 'turn_error') {
              track.active = false; track.lastInterrupted = false;
              track.currentTool = null; track.textBuffer = '';
              track.toolSuccess = null; track.bufferType = null; track.lastOutput = ''; track.clearOnNextDelta = false;
              track.lastError = (ev.error as string) ?? 'error';
              track.referenceMs = Date.now();
            } else if (ev.type === 'turn_interrupted') {
              track.active = false; track.lastInterrupted = true;
              track.currentTool = null; track.textBuffer = '';
              track.toolSuccess = null; track.bufferType = null; track.lastOutput = ''; track.clearOnNextDelta = false;
              track.referenceMs = Date.now();
            }
          } catch {
            // silent: malformed event skip — single event parse failure, next event continues; track partial state remains
          }
        }
        updateClawPanel(clawTrackMap);
        requestRender();
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
        await clawWatchers.get(id)?.close();
        clawWatchers.delete(id);
        clawTrackMap.delete(id);
      }
    }

    for (const rawClawId of clawIds) {
      const clawId = rawClawId;
      const loc = clawTopology.resolve(makeClawId(clawId));
      if (loc.kind !== 'local') continue;
      const streamFile = path.join(loc.clawDir, STREAM_FILE);
      if (!clawTrackMap.has(clawId)) {
        const clawDir = loc.clawDir;
        const contractMs = getContractCreatedMs(fs, clawDir, audit);
        if (contractMs === null) continue;
        const track = makeClawTrack();
        track.hasContract = true;
        track.referenceMs = contractMs;
        clawTrackMap.set(clawId, track);
      }
      if (!clawWatchers.has(clawId)) {
        attachClawWatcher(clawId, streamFile);
      }
      const track = clawTrackMap.get(clawId)!;
      try {
        const stored = await pm.readPid(makeClawId(clawId));
        track.isAlive = stored !== null && isAlive(stored.pid);
      } catch (e) {
        if (!isFileNotFound(e)) {
          process.stderr.write(`[viewport] readPid failed: ${(e as Error).message}\n`);
        }
        track.isAlive = false;
      }
      const loc2 = clawTopology.resolve(makeClawId(clawId));
      if (loc2.kind !== 'local') continue;
      track.hasContract = getContractCreatedMs(fs, loc2.clawDir, audit) !== null;
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
  };

  return { attachClawWatcher, refreshClawStatus, refreshAllClawStatus, detachWatcher, detachAllWatchers, closeAll };
};
