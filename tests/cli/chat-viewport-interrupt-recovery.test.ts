/** Phase 2135 Step D：恢复 active 后，真实 Esc 写文件经 watcher callback 驱动 abort。 */
import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  DAEMON_HEARTBEAT_FILE,
  DAEMON_TURN_STATE_FILE,
} from '../../src/daemon/index.js';
import { DAEMON_AUDIT_EVENTS } from '../../src/daemon/audit-events.js';
import { createInterruptWatcher } from '../../src/daemon/interrupt-watcher.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import type { WatchEvent, WatcherFactory } from '../../src/foundation/file-watcher/index.js';
import { createTuiInputHandler, type InputHandlerDeps } from '../../src/viewport/chat-viewport-input.js';
import { recoverMotionTurnState } from '../../src/viewport/chat-viewport-turn-recovery.js';
import { cleanupTempDirSync, createTrackedTempDirSync } from '../utils/temp.js';

describe('chat viewport recovered-turn Esc integration', () => {
  it('persists a real interrupt file after recovery and aborts through the real watcher callback', () => {
    const agentDir = createTrackedTempDirSync('viewport-esc-recovery-');
    try {
      const now = 1_000_000;
      const agentFs = new NodeFileSystem({ baseDir: agentDir });
      agentFs.writeAtomicSync(DAEMON_TURN_STATE_FILE, JSON.stringify({
        schema_version: 1,
        phase: 'active',
        revision: 1,
        updatedAtMs: now - 1_000,
        startedAtMs: now - 2_000,
        clawId: 'motion',
        daemonPid: 4242,
      }));
      agentFs.writeAtomicSync(DAEMON_HEARTBEAT_FILE, JSON.stringify({
        schema_version: 2,
        ts: now - 1_000,
        pid: 4242,
        generation_id: 'generation-current',
        start_time: 'start-current',
      }));

      let active = false;
      const turnTracker = {
        begin: vi.fn(() => { active = true; }),
        forceReset: vi.fn(() => { active = false; }),
        isActive: () => active,
        requestInterrupt: vi.fn(),
      };
      const audit = { write: vi.fn() };
      recoverMotionTurnState({
        fs: agentFs,
        clawId: 'motion',
        turnTracker,
        audit,
        now: () => now,
      });
      expect(active).toBe(true);

      const abort = vi.fn();
      const onError = vi.fn();
      let watchCallback: (event: WatchEvent) => void = () => {
        throw new Error('watcher callback not captured');
      };
      const createWatcher: WatcherFactory = (_path, callback) => {
        watchCallback = callback;
        return {
          close: vi.fn(() => Promise.resolve()),
          isActive: () => true,
          getPath: () => path.join(agentDir, 'interrupt'),
        };
      };
      createInterruptWatcher({
        agentFs,
        agentDir,
        onInterrupt: abort,
        onError,
        audit,
        createWatcher,
      });

      const input = createTuiInputHandler({
        fs: agentFs,
        audit: audit as unknown as InputHandlerDeps['audit'],
        agentDir,
        turnTracker: turnTracker as unknown as InputHandlerDeps['turnTracker'],
        mainUI: {
          enterPhase: vi.fn(),
          clearPreview: vi.fn(),
          appendToBuffer: vi.fn(),
          flushStreamingNormal: vi.fn(),
        } as unknown as InputHandlerDeps['mainUI'],
        editor: { getText: () => '', setText: vi.fn() },
        requestRender: vi.fn(),
        resolveExit: vi.fn(),
        setShutdownReason: vi.fn(),
      });

      expect(input('\x1b')).toEqual({ consume: true });
      const interruptPath = path.join(agentDir, 'interrupt');
      expect(fs.existsSync(interruptPath)).toBe(true);
      expect(turnTracker.requestInterrupt).toHaveBeenCalledWith('esc');

      watchCallback({ type: 'add', path: interruptPath });

      expect(fs.existsSync(interruptPath)).toBe(false);
      expect(abort).toHaveBeenCalledTimes(1);
      expect(onError).not.toHaveBeenCalled();
      expect(audit.write).toHaveBeenCalledWith(DAEMON_AUDIT_EVENTS.LOOP_INTERRUPT_FILE_DELETED);
      expect(audit.write).toHaveBeenCalledWith(DAEMON_AUDIT_EVENTS.LOOP_INTERRUPT_ABORT_SUCCEEDED);
    } finally {
      cleanupTempDirSync(agentDir);
    }
  });
});
